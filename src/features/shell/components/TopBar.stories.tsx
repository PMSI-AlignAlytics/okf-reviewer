// The custom window chrome: bundle switcher, history, search, and window
// controls, over the real store.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { WithStore } from "@/mock/withStore.tsx";
import { TopBar } from "./TopBar.tsx";

const meta = {
  title: "Shell/TopBar",
  component: TopBar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TopBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BundleOpen: Story = {
  render: () => (
    <WithStore withBundle>
      <TopBar />
    </WithStore>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /switch bundle/i })).toBeVisible(),
    );
    await expect(canvas.getByRole("button", { name: /search concepts/i })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /create shareable bundle/i }))
      .not.toBeInTheDocument();
  },
};

export const NoBundle: Story = {
  render: () => (
    <WithStore>
      <TopBar />
    </WithStore>
  ),
};
