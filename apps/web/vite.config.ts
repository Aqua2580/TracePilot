import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dashboard 固定由 API 的 /dashboard 同源路径提供，避免配置跨域地址或让
 * 浏览器把人工审批凭证发送给其他来源。
 */
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()]
});
