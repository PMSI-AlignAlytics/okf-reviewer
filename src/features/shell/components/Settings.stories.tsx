import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { WithStore } from "@/mock/withStore.tsx";
import { useApp } from "@/shared/store.tsx";
import { Settings } from "./Settings.tsx";
import type { SettingsProps } from "./Settings.tsx";

function OpenSettings(props: SettingsProps) {
  const { actions } = useApp();
  useEffect(() => actions.setSettingsOpen(true), [actions]);
  return <Settings {...props} />;
}

const meta = {
  title: "Shell/Settings",
  component: OpenSettings,
  decorators: [
    (Story) => (
      <WithStore>
        <Story />
      </WithStore>
    ),
  ],
} satisfies Meta<typeof OpenSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const General: Story = {
  args: { initialSection: "general" },
};

export const Reviewer: Story = {
  args: { initialSection: "reviewer" },
};

export const Search: Story = {
  args: { initialQuery: "reader" },
};
