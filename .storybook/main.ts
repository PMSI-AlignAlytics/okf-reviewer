// Storybook for the OKF Reviewer component playground. The react-vite framework
// reuses vite.config.ts (the @ alias and the React Compiler Babel plugin).
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-vitest"],
};

export default config;
