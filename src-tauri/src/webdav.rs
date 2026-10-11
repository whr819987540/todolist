//! WebDAV 连接配置与客户端（用于备份设置和待办数据）。
//!
//! 服务地址、用户名、远程目录保存在数据根目录的 `.webdav.json`；
//! 密码保存在 Windows 凭据管理器，不写进任何文件，也就不会进入备份包。

use crate::store::{atomic_write, strip_bom};
use percent_encoding::percent_decode_str;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const CONFIG_FILE: &str = ".webdav.json";
const DAV: &str = "DAV:";
/// 下载大小上限：设置备份只有几 KB，超过说明不是备份文件
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024;
/// 上传、下载备份文件的超时：待办数据的备份可能有几十 MB，比别的请求（60 秒）宽得多
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#;

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebDavConfig {
    /// 服务地址，如 https://dav.jianguoyun.com/dav/
    pub url: String,
    pub username: String,
    /// 存放备份的目录，相对于服务地址，可以多级（用 / 分隔），空表示直接放在服务地址下
    pub dir: String,
}

impl Default for WebDavConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            dir: "TodoList".into(),
        }
    }
}

impl WebDavConfig {
    /// 去掉首尾空白、统一目录写法，并检查地址和目录是否合法（地址为空表示还没配置，允许保存）
    fn normalized(&self) -> Result<Self> {
        let url = self.url.trim().to_string();
        if !url.is_empty() {
            base_url(&url)?;
        }
        Ok(Self {
            url,
            username: self.username.trim().to_string(),
            dir: dir_segments(&self.dir)?.join("/"),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavInfo {
    pub config: WebDavConfig,
    /// 凭据管理器里是否已保存密码（密码本身不返回给前端）
    pub has_password: bool,
}

pub struct WebDavStore {
    path: PathBuf,
    /// 凭据管理器里的服务名，用应用 identifier，正式版和测试版互不影响
    service: String,
    current: Mutex<WebDavConfig>,
}

impl WebDavStore {
    /// 文件不存在或内容损坏时使用默认配置
    pub fn load(root: &Path, service: &str) -> Self {
        let path = root.join(CONFIG_FILE);
        let current = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(strip_bom(&b)).ok())
            .unwrap_or_default();
        Self {
            path,
            service: service.to_string(),
            current: Mutex::new(current),
        }
    }

    fn lock(&self) -> MutexGuard<'_, WebDavConfig> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self) -> WebDavConfig {
        self.lock().clone()
    }

    pub fn info(&self) -> WebDavInfo {
        WebDavInfo {
            config: self.get(),
            has_password: matches!(self.password(), Ok(Some(_))),
        }
    }

    /// password 为 None 或空时保留原来的密码
    pub fn save(&self, config: &WebDavConfig, password: Option<&str>) -> Result<()> {
        let next = config.normalized()?;
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            self.entry()?
                .set_password(pw)
                .map_err(|e| format!("保存 WebDAV 密码失败：{e}"))?;
        }
        let mut cur = self.lock();
        let json = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        atomic_write(&self.path, &json).map_err(|e| format!("保存 WebDAV 设置失败：{e}"))?;
        *cur = next;
        Ok(())
    }

    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, "webdav").map_err(|e| format!("无法访问 Windows 凭据管理器：{e}"))
    }

    pub fn password(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取 WebDAV 密码失败：{e}")),
        }
    }

    /// 用已保存的配置和密码连接
    pub fn connect(&self) -> Result<WebDav> {
        let config = self.get();
        if config.url.is_empty() {
            return Err("请先填写并保存 WebDAV 服务器地址".into());
        }
        WebDav::new(&config, &self.password()?.unwrap_or_default())
    }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct RemoteFile {
    pub name: String,
    pub size: Option<u64>,
}

pub struct WebDav {
    client: Client,
    /// 服务地址，以 / 结尾
    base: Url,
    /// 备份目录的各级名称
    dirs: Vec<String>,
    username: String,
    password: String,
}

impl WebDav {
    pub fn new(config: &WebDavConfig, password: &str) -> Result<Self> {
        if config.url.trim().is_empty() {
            return Err("请填写 WebDAV 服务器地址".into());
        }
        let builder = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("TodoList/", env!("CARGO_PKG_VERSION")));
        let builder = match proxy() {
            Some(p) => builder.proxy(p),
            None => builder.no_proxy(),
        };
        let client = builder.build().map_err(|e| format!("初始化网络连接失败：{e}"))?;
        Ok(Self {
            client,
            base: base_url(&config.url)?,
            dirs: dir_segments(&config.dir)?,
            username: config.username.trim().to_string(),
            password: password.to_string(),
        })
    }

    /// 备份目录在提示里的写法
    pub fn dir_label(&self) -> String {
        format!("「/{}」", self.dirs.join("/"))
    }

    /// 备份目录的前 n 级（以 / 结尾）
    fn dir_url(&self, n: usize) -> Url {
        self.dirs[..n].iter().fold(self.base.clone(), |url, name| child(&url, name, true))
    }

    fn backup_dir(&self) -> Url {
        self.dir_url(self.dirs.len())
    }

    fn request(&self, method: Method, url: Url) -> RequestBuilder {
        let rb = self.client.request(method, url);
        if self.username.is_empty() {
            rb
        } else {
            rb.basic_auth(&self.username, Some(&self.password))
        }
    }

    async fn propfind(&self, url: Url, depth: &str) -> Result<Response> {
        let rb = self
            .request(method(b"PROPFIND"), url)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PROPFIND_BODY);
        send(rb).await
    }

    /// 测试连接：服务地址是 WebDAV、账号密码正确。返回备份目录是否已经存在
    pub async fn check(&self) -> Result<bool> {
        let status = self.propfind(self.base.clone(), "0").await?.status();
        expect_ok(status, "连接")?;
        if status != StatusCode::MULTI_STATUS {
            return Err(format!("服务器没有按 WebDAV 协议响应（HTTP {}），请确认填写的是 WebDAV 地址", status.as_u16()));
        }
        self.exists(self.backup_dir()).await
    }

    async fn exists(&self, url: Url) -> Result<bool> {
        let status = self.propfind(url, "0").await?.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(false);
        }
        expect_ok(status, "访问远程目录")?;
        Ok(true)
    }

    /// 备份目录不存在时逐级创建
    async fn ensure_dir(&self) -> Result<()> {
        if self.exists(self.backup_dir()).await? {
            return Ok(());
        }
        for n in 1..=self.dirs.len() {
            let status = send(self.request(method(b"MKCOL"), self.dir_url(n))).await?.status();
            // 405 表示这一级已经存在
            if status != StatusCode::METHOD_NOT_ALLOWED {
                expect_ok(status, "创建远程目录")?;
            }
        }
        Ok(())
    }

    pub async fn upload(&self, name: &str, data: Vec<u8>) -> Result<()> {
        self.ensure_dir().await?;
        let rb = self
            .request(Method::PUT, child(&self.backup_dir(), name, false))
            .header("Content-Type", "application/zip")
            .timeout(TRANSFER_TIMEOUT)
            .body(data);
        expect_ok(send(rb).await?.status(), "上传")
    }

    /// 备份目录里的文件（不含子目录）；目录还不存在时返回空列表
    pub async fn list(&self) -> Result<Vec<RemoteFile>> {
        let resp = self.propfind(self.backup_dir(), "1").await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        expect_ok(resp.status(), "获取备份列表")?;
        let bytes = resp.bytes().await.map_err(net_error)?;
        parse_propfind(&String::from_utf8_lossy(&bytes))
    }

    /// 下载（设置备份，放在内存里）
    pub async fn download(&self, name: &str) -> Result<Vec<u8>> {
        let resp = self.get(name).await?;
        let too_big = || format!("文件超过 {} KB，不是本软件的设置备份", MAX_DOWNLOAD_BYTES / 1024);
        if resp.content_length().is_some_and(|n| n > MAX_DOWNLOAD_BYTES) {
            return Err(too_big());
        }
        let bytes = resp.bytes().await.map_err(net_error)?;
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(too_big());
        }
        Ok(bytes.to_vec())
    }

    /// 下载到本地文件（待办数据的备份，可能很大，边收边写，不全放在内存里）
    pub async fn download_to(&self, name: &str, path: &Path) -> Result<()> {
        let mut resp = self.get(name).await?;
        let mut file = fs::File::create(path).map_err(|e| format!("保存下载的文件失败：{e}"))?;
        while let Some(chunk) = resp.chunk().await.map_err(net_error)? {
            file.write_all(&chunk).map_err(|e| format!("保存下载的文件失败：{e}"))?;
        }
        file.sync_all().map_err(|e| format!("保存下载的文件失败：{e}"))
    }

    async fn get(&self, name: &str) -> Result<Response> {
        let rb = self.request(Method::GET, child(&self.backup_dir(), name, false)).timeout(TRANSFER_TIMEOUT);
        let resp = send(rb).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Err(format!("远程文件 {name} 不存在，可能已被删除，请刷新列表"));
        }
        expect_ok(resp.status(), "下载")?;
        Ok(resp)
    }

    /// 删除备份目录里的文件（自动备份只留最近几份）；已经不在了不算失败
    pub async fn delete(&self, name: &str) -> Result<()> {
        let status = send(self.request(Method::DELETE, child(&self.backup_dir(), name, false))).await?.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        expect_ok(status, "删除远程的旧备份")
    }
}

fn method(name: &'static [u8]) -> Method {
    Method::from_bytes(name).expect("valid method")
}

async fn send(rb: RequestBuilder) -> Result<Response> {
    rb.send().await.map_err(net_error)
}

/// reqwest 的错误信息只有一句 "error sending request"，具体原因（DNS、证书、拒绝连接）在 source 链的最底层
fn net_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return "连接 WebDAV 服务器超时，请检查网络和服务器地址".into();
    }
    let mut reason = e.to_string();
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        reason = s.to_string();
        source = s.source();
    }
    if e.is_connect() {
        format!("无法连接 WebDAV 服务器：{reason}")
    } else {
        format!("网络请求失败：{reason}")
    }
}

fn expect_ok(status: StatusCode, action: &str) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    let code = status.as_u16();
    let reason = match code {
        401 => "用户名或密码错误",
        403 => "没有权限，请检查账号权限和远程目录",
        404 => "地址不存在，请检查 WebDAV 地址",
        405 => "服务器不支持该操作，请确认填写的是 WebDAV 地址",
        409 => "上级目录不存在",
        423 => "文件被锁定",
        507 => "服务器空间不足",
        _ => "服务器返回错误",
    };
    Err(format!("{action}失败：{reason}（HTTP {code}）"))
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

/// 代理地址：环境变量 HTTPS_PROXY / HTTP_PROXY 优先，其次是 Windows 的「代理服务器」设置；
/// 不走代理的地址：合并 Internet 选项里的「例外」和环境变量 NO_PROXY。
///
/// 不用 reqwest 自带的系统代理：它优先读 NO_PROXY，却只认逗号分隔、不认 `127.*` 这种写法，
/// 而 Windows 上的 NO_PROXY 常是分号分隔的（Clash 等工具就这样设置），结果局域网地址也被转给了代理。
/// 也不能用 `Proxy::custom(..).no_proxy(..)`：reqwest 对自定义代理不检查 no_proxy，所以在闭包里自己判断
fn proxy() -> Option<reqwest::Proxy> {
    let env = |names: &[&str]| {
        names
            .iter()
            .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
    };
    let system = system_proxy();
    let server = env(&["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])
        .or_else(|| system.as_ref().map(|(server, _)| server.clone()))?;
    let server = proxy_server_url(&server)?;
    let bypass = [system.map(|(_, bypass)| bypass), env(&["NO_PROXY", "no_proxy"])]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(";");
    let bypass = Bypass::parse(&bypass);
    Some(reqwest::Proxy::custom(move |url| {
        (!bypass.matches(url.host_str()?)).then(|| server.clone())
    }))
}

/// Windows「设置 → 网络 → 代理」里手动设置的代理：(代理服务器, 例外列表)
#[cfg(windows)]
fn system_proxy() -> Option<(String, String)> {
    let key = windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    if key.get_u32("ProxyEnable").ok()? == 0 {
        return None;
    }
    let server = key.get_string("ProxyServer").ok()?;
    Some((server, key.get_string("ProxyOverride").unwrap_or_default()))
}

#[cfg(not(windows))]
fn system_proxy() -> Option<(String, String)> {
    None
}

/// 代理服务器写法：`127.0.0.1:7890`、`http://…`，或按协议分开的 `http=…;https=…`（只支持 HTTP 代理）
fn proxy_server_url(server: &str) -> Option<Url> {
    let server = server.trim();
    let addr = if server.contains('=') {
        let find = |scheme: &str| {
            server
                .split(';')
                .find_map(|part| part.trim().strip_prefix(scheme)?.strip_prefix('='))
        };
        find("https").or_else(|| find("http"))?.trim()
    } else {
        server
    };
    let url = if addr.contains("://") { addr.to_string() } else { format!("http://{addr}") };
    Url::parse(&url).ok().filter(|u| matches!(u.scheme(), "http" | "https"))
}

/// 不走代理的地址，写法兼容 Internet 选项的「例外」和 NO_PROXY，分号、逗号分隔都认
struct Bypass(Vec<BypassRule>);

enum BypassRule {
    /// `<local>`：不带点的主机名，如 http://nas:5005
    Local,
    /// `*`
    All,
    /// `192.168.*`、`10.0.0.0/8`：(网络号, 掩码)
    Net(u32, u32),
    /// `example.com`、`*.example.com`、`.example.com` 都匹配它和它的子域名；IP 地址精确匹配
    Host(String),
}

impl Bypass {
    fn parse(raw: &str) -> Self {
        let rule = |entry: &str| {
            if entry.eq_ignore_ascii_case("<local>") {
                BypassRule::Local
            } else if entry == "*" {
                BypassRule::All
            } else if let Some((net, mask)) = ipv4_net(entry) {
                BypassRule::Net(net, mask)
            } else {
                BypassRule::Host(entry.trim_start_matches('*').trim_start_matches('.').to_ascii_lowercase())
            }
        };
        Self(raw.split([';', ',']).map(str::trim).filter(|e| !e.is_empty()).map(rule).collect())
    }

    fn matches(&self, host: &str) -> bool {
        let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        let ip = host.parse::<Ipv4Addr>().ok().map(u32::from);
        self.0.iter().any(|rule| match rule {
            BypassRule::Local => !host.contains(['.', ':']),
            BypassRule::All => true,
            BypassRule::Net(net, mask) => ip.is_some_and(|ip| ip & mask == *net),
            BypassRule::Host(h) => host == *h || host.strip_suffix(h.as_str()).is_some_and(|rest| rest.ends_with('.')),
        })
    }
}

/// `192.168.*`、`10.1.2.*` 或 `10.0.0.0/8` 形式的 IPv4 网段，返回 (网络号, 掩码)
fn ipv4_net(entry: &str) -> Option<(u32, u32)> {
    let (addr, bits) = match entry.strip_suffix(".*") {
        Some(prefix) => {
            let n = prefix.split('.').count();
            if n > 3 {
                return None;
            }
            (format!("{prefix}{}", ".0".repeat(4 - n)), n as u32 * 8)
        }
        None => {
            let (addr, bits) = entry.split_once('/')?;
            (addr.to_string(), bits.parse().ok().filter(|b| *b <= 32)?)
        }
    };
    let mask = u32::MAX.checked_shl(32 - bits).unwrap_or(0);
    Some((u32::from(addr.parse::<Ipv4Addr>().ok()?) & mask, mask))
}

// ---------------------------------------------------------------------------
// 地址处理与响应解析
// ---------------------------------------------------------------------------

/// 服务地址，统一以 / 结尾
fn base_url(url: &str) -> Result<Url> {
    let invalid = || "WebDAV 地址格式不正确，应以 http:// 或 https:// 开头，例如 https://dav.jianguoyun.com/dav/".to_string();
    let mut url = Url::parse(url.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.cannot_be_a_base() || url.host_str().is_none() {
        return Err(invalid());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// 远程目录拆成各级名称；/ 和 \ 都当分隔符
fn dir_segments(dir: &str) -> Result<Vec<String>> {
    dir.split(['/', '\\'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| match s {
            "." | ".." => Err("远程目录不能包含 . 或 ..".to_string()),
            _ => Ok(s.to_string()),
        })
        .collect()
}

/// 在目录（以 / 结尾）下追加一级，名称会做百分号编码
fn child(dir: &Url, name: &str, is_dir: bool) -> Url {
    let mut url = dir.clone();
    {
        let mut segments = url.path_segments_mut().expect("base url 可以追加路径");
        segments.pop_if_empty().push(name);
        if is_dir {
            segments.push("");
        }
    }
    url
}

/// 解析 PROPFIND 的 207 响应，返回其中的文件（跳过目录）
fn parse_propfind(xml: &str) -> Result<Vec<RemoteFile>> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("无法解析服务器返回的文件列表：{e}"))?;
    let files = doc
        .descendants()
        .filter(|n| n.has_tag_name((DAV, "response")))
        .filter(|resp| !resp.descendants().any(|n| n.has_tag_name((DAV, "collection"))))
        .filter_map(|resp| {
            let href = resp.children().find(|n| n.has_tag_name((DAV, "href")))?.text()?.trim();
            let last = href.trim_end_matches('/').rsplit('/').next()?;
            let name = percent_decode_str(last).decode_utf8().ok()?.into_owned();
            let size = resp
                .descendants()
                .find(|n| n.has_tag_name((DAV, "getcontentlength")))
                .and_then(|n| n.text())
                .and_then(|t| t.trim().parse().ok());
            (!name.is_empty()).then_some(RemoteFile { name, size })
        })
        .collect();
    Ok(files)
}

/// 单元测试用的 WebDAV 服务器：在本机随便一个端口上，文件放在内存里，只认客户端用到的 PROPFIND、MKCOL、PUT、GET、DELETE
#[cfg(test)]
pub(crate) mod fake {
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct Files {
        pub dirs: BTreeSet<String>,
        /// 路径（百分号编码的，同请求里的）→ 内容
        pub files: BTreeMap<String, Vec<u8>>,
    }

    pub struct Server {
        pub url: String,
        pub state: Arc<Mutex<Files>>,
    }

    impl Server {
        /// 服务地址是 http://127.0.0.1:端口/dav/
        pub fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/dav/", listener.local_addr().unwrap());
            let state = Arc::new(Mutex::new(Files::default()));
            state.lock().unwrap().dirs.insert("/dav/".into());
            let shared = state.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    handle(stream, &shared);
                }
            });
            Self { url, state }
        }

        /// 备份目录里的文件名
        pub fn names(&self, dir: &str) -> Vec<String> {
            let prefix = format!("/dav/{dir}/");
            let files = &self.state.lock().unwrap().files;
            files.keys().filter_map(|k| k.strip_prefix(&prefix).map(str::to_string)).collect()
        }
    }

    fn handle(mut stream: TcpStream, state: &Mutex<Files>) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let head_end = loop {
            let Ok(n) = stream.read(&mut chunk) else { return };
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let mut lines = head.lines();
        let mut first = lines.next().unwrap_or_default().split(' ');
        let (method, path) = (first.next().unwrap_or_default().to_string(), first.next().unwrap_or_default().to_string());
        let len: usize = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse().ok())
            .unwrap_or(0);
        let mut body = buf[head_end..].to_vec();
        while body.len() < len {
            let Ok(n) = stream.read(&mut chunk) else { return };
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        let mut files = state.lock().unwrap();
        let (status, content): (&str, Vec<u8>) = match method.as_str() {
            "PROPFIND" => {
                let dir = files.dirs.contains(&path);
                if !dir && !files.files.contains_key(&path) {
                    ("404 Not Found", Vec::new())
                } else {
                    let mut xml = String::from(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">"#);
                    let entry = |href: &str, collection: bool, size: usize| {
                        let kind = if collection { "<d:collection/>" } else { "" };
                        format!("<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype>{kind}</d:resourcetype><d:getcontentlength>{size}</d:getcontentlength></d:prop></d:propstat></d:response>")
                    };
                    xml += &entry(&path, dir, 0);
                    if dir {
                        for (p, data) in files.files.iter().filter(|(p, _)| p.strip_prefix(&path).is_some_and(|rest| !rest.contains('/'))) {
                            xml += &entry(p, false, data.len());
                        }
                    }
                    xml += "</d:multistatus>";
                    ("207 Multi-Status", xml.into_bytes())
                }
            }
            "MKCOL" if files.dirs.contains(&path) => ("405 Method Not Allowed", Vec::new()),
            "MKCOL" => {
                files.dirs.insert(path);
                ("201 Created", Vec::new())
            }
            "PUT" => {
                files.files.insert(path, body);
                ("201 Created", Vec::new())
            }
            "GET" => match files.files.get(&path) {
                Some(data) => ("200 OK", data.clone()),
                None => ("404 Not Found", Vec::new()),
            },
            "DELETE" => match files.files.remove(&path) {
                Some(_) => ("204 No Content", Vec::new()),
                None => ("404 Not Found", Vec::new()),
            },
            _ => ("405 Method Not Allowed", Vec::new()),
        };
        drop(files);
        let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", content.len());
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(&content);
    }

    /// 连这个服务器的客户端（备份目录是 dir）
    pub fn client(server: &Server, dir: &str) -> super::WebDav {
        let config = super::WebDavConfig { url: server.url.clone(), username: "u".into(), dir: dir.into() };
        super::WebDav::new(&config, "p").unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploads_lists_downloads_and_deletes() {
        let server = fake::Server::start();
        let dav = fake::client(&server, "备份/TodoList");
        use tauri::async_runtime::block_on as run;
        // 远程目录还没有：列表是空的，上传时逐级建好
        assert!(run(dav.list()).unwrap().is_empty());
        run(dav.upload("TodoList-data-20261009-153012.zip", b"zip-data".to_vec())).unwrap();
        run(dav.upload("TodoList-settings-20261009-153012.zip", b"settings".to_vec())).unwrap();
        let mut names: Vec<String> = run(dav.list()).unwrap().into_iter().map(|f| f.name).collect();
        names.sort();
        assert_eq!(names, ["TodoList-data-20261009-153012.zip", "TodoList-settings-20261009-153012.zip"]);
        // 数据备份下载到文件里
        let dir = std::env::temp_dir().join(format!("todolist-webdav-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("download.zip");
        run(dav.download_to("TodoList-data-20261009-153012.zip", &file)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"zip-data");
        assert!(run(dav.download_to("没有的.zip", &file)).unwrap_err().contains("不存在"));
        assert_eq!(run(dav.download("TodoList-settings-20261009-153012.zip")).unwrap(), b"settings");
        // 删除；已经不在了不算失败
        run(dav.delete("TodoList-data-20261009-153012.zip")).unwrap();
        run(dav.delete("TodoList-data-20261009-153012.zip")).unwrap();
        assert_eq!(server.names("%E5%A4%87%E4%BB%BD/TodoList"), ["TodoList-settings-20261009-153012.zip"]);
        let _ = fs::remove_dir_all(&dir);
    }

    fn dav(url: &str, dir: &str) -> WebDav {
        let config = WebDavConfig {
            url: url.into(),
            username: String::new(),
            dir: dir.into(),
        };
        WebDav::new(&config, "").unwrap()
    }

    #[test]
    fn builds_urls() {
        let d = dav("https://dav.jianguoyun.com/dav", " 备份 / TodoList\\ ");
        assert_eq!(d.base.as_str(), "https://dav.jianguoyun.com/dav/");
        assert_eq!(d.dir_url(1).as_str(), "https://dav.jianguoyun.com/dav/%E5%A4%87%E4%BB%BD/");
        assert_eq!(
            d.backup_dir().as_str(),
            "https://dav.jianguoyun.com/dav/%E5%A4%87%E4%BB%BD/TodoList/"
        );
        assert_eq!(
            child(&d.backup_dir(), "a b#.zip", false).as_str(),
            "https://dav.jianguoyun.com/dav/%E5%A4%87%E4%BB%BD/TodoList/a%20b%23.zip"
        );
        // 目录为空时直接放在服务地址下
        assert_eq!(dav("http://127.0.0.1:8080/", "").backup_dir().as_str(), "http://127.0.0.1:8080/");
    }

    #[test]
    fn rejects_bad_config() {
        assert!(base_url("dav.jianguoyun.com/dav/").is_err());
        assert!(base_url("ftp://example.com/").is_err());
        assert!(dir_segments("a/../b").is_err());
        let config = WebDavConfig {
            url: "  ".into(),
            username: " u ".into(),
            dir: "/a//b/".into(),
        };
        assert_eq!(
            config.normalized().unwrap(),
            WebDavConfig {
                url: String::new(),
                username: "u".into(),
                dir: "a/b".into()
            }
        );
    }

    #[test]
    fn proxy_settings() {
        // Internet 选项的例外列表 + 分号分隔的 NO_PROXY（Clash 的写法）
        let bypass = Bypass::parse("localhost;127.*;192.168.*;*.lan;<local>;100.88.127.104, .example.com,10.0.0.0/8");
        for host in [
            "localhost",
            "127.0.0.1",
            "192.168.1.10",
            "nas",
            "NAS.lan",
            "100.88.127.104",
            "example.com",
            "dav.example.com",
            "10.2.3.4",
        ] {
            assert!(bypass.matches(host), "{host} 应该直连");
        }
        for host in ["dav.jianguoyun.com", "192.169.0.1", "100.88.127.10", "notexample.com", "[::1]"] {
            assert!(!bypass.matches(host), "{host} 应该走代理");
        }
        assert!(Bypass::parse("*").matches("dav.jianguoyun.com"));
        assert_eq!(ipv4_net("10.1.2.*"), Some((0x0a01_0200, 0xffff_ff00)));
        assert_eq!(ipv4_net("0.0.0.0/0"), Some((0, 0)));
        assert_eq!(ipv4_net("abc.*"), None);

        let url = |s| proxy_server_url(s).map(|u| u.to_string());
        assert_eq!(url("127.0.0.1:7890").as_deref(), Some("http://127.0.0.1:7890/"));
        assert_eq!(
            url("http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892").as_deref(),
            Some("http://127.0.0.1:7891/")
        );
        assert_eq!(url("socks=127.0.0.1:7892"), None);
    }

    #[test]
    fn parses_propfind() {
        // 坚果云 / Nextcloud 风格：d: 前缀，href 是百分号编码的绝对路径
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <d:response><d:href>/dav/%E5%A4%87%E4%BB%BD/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response><d:href>/dav/%E5%A4%87%E4%BB%BD/TodoList-settings-20260926-153012.zip</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>512</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"#;
        // Apache mod_dav 风格：默认命名空间、完整 URL、getcontentlength 缺失
        let xml2 = r#"<multistatus xmlns="DAV:"><response>
  <href>http://nas.local/webdav/%E8%AE%BE%E7%BD%AE.zip</href>
  <propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat>
</response></multistatus>"#;
        assert_eq!(
            parse_propfind(xml).unwrap(),
            vec![RemoteFile {
                name: "TodoList-settings-20260926-153012.zip".into(),
                size: Some(512)
            }]
        );
        assert_eq!(
            parse_propfind(xml2).unwrap(),
            vec![RemoteFile {
                name: "设置.zip".into(),
                size: None
            }]
        );
        assert!(parse_propfind("<html>").is_err());
    }
}
