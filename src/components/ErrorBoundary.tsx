import { Button, Result } from "antd";
import { Component, type ReactNode } from "react";

/** 渲染出错时显示提示而不是整窗空白。数据都在磁盘上，重新加载即可恢复 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Result
        status="error"
        title="界面出错了"
        subTitle={`已保存的数据不会丢失，重新加载即可继续使用。错误信息：${this.state.error.message}`}
        extra={
          <Button type="primary" onClick={() => location.reload()}>
            重新加载
          </Button>
        }
      />
    );
  }
}
