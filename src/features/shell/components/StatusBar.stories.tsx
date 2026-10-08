import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { WithStore } from "@/mock/withStore.tsx";
import { StatusBar } from "./StatusBar.tsx";

const meta = {
  title: "Shell/StatusBar",
  component: StatusBar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BundleOpen: Story = {
  render: () => (
    <WithStore withBundle>
      <StatusBar />
    </WithStore>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const validation = await waitFor(() =>
      canvas.getByRole("button", { name: "Toggle validation panel" })
    );
    await expect(validation).toBeVisible();
    await userEvent.click(validation);
    await expect(validation).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Toggle bundle log" })).toBeVisible();
  },
};

export const NoBundle: Story = {
  render: () => (
    <WithStore>
      <StatusBar />
    </WithStore>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  },
};
