import { defineConfig } from "vitepress";

export default defineConfig({
  title: "ysa",
  description: "Secure container runtime for AI coding agents. CLI and SDK — nothing else.",
  base: "/docs/",
  appearance: "force-dark",
  cleanUrls: true,
  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo.svg" },
    nav: [
      { text: "CLI", link: "/cli/" },
      { text: "API", link: "/api/" },
      { text: "Guides", link: "/guides/first-task" },
      { text: "GitHub", link: "https://github.com/ysa-ai/ysa" },
    ],
    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Introduction", link: "/" },
          { text: "First Task", link: "/guides/first-task" },
        ],
      },
      {
        text: "CLI Reference",
        items: [
          { text: "Overview", link: "/cli/" },
          { text: "ysa run", link: "/cli/run" },
          { text: "ysa refine", link: "/cli/refine" },
          { text: "ysa list", link: "/cli/list" },
          { text: "ysa logs", link: "/cli/logs" },
          { text: "ysa stop", link: "/cli/stop" },
          { text: "ysa teardown", link: "/cli/teardown" },
          { text: "ysa runtime", link: "/cli/runtime" },
          { text: "ysa setup", link: "/cli/setup" },
        ],
      },
      {
        text: "API Reference",
        items: [
          { text: "Overview", link: "/api/" },
          { text: "runTask()", link: "/api/run-task" },
          { text: "runInteractive()", link: "/api/run-interactive" },
          { text: "Providers", link: "/api/providers" },
          { text: "Types", link: "/api/types" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Runtimes & .ysa.toml", link: "/guides/runtimes" },
          { text: "Network Policies", link: "/guides/network" },
          { text: "Review Tasks", link: "/guides/review-tasks" },
          { text: "Providers", link: "/guides/providers" },
          { text: "Dependency Cache", link: "/guides/dep-cache" },
          { text: "Symphony Integration", link: "/guides/symphony" },
          { text: "ysa vs OpenShell", link: "/guides/openshell" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/ysa-ai/ysa" }],
    search: { provider: "local" },
  },
});
