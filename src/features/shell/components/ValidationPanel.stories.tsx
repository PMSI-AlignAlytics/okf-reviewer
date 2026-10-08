import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { expect, within } from "storybook/test";
import { WithStore } from "@/mock/withStore.tsx";
import { useApp } from "@/shared/store.tsx";
import { ValidationPanel } from "./ValidationPanel.tsx";

function OpenReport() {
  const { state, actions } = useApp();
  useEffect(() => {
    if (!state.panels.validation) actions.togglePanel("validation", true);
  }, [state.panels.validation, actions]);
  return <ValidationPanel />;
}

const meta = {
  title: "Shell/CompatibilityReport",
  component: OpenReport,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <WithStore withBundle>
        <div style={{ minHeight: "760px", background: "var(--bg)" }}>
          <Story />
        </div>
      </WithStore>
    ),
  ],
} satisfies Meta<typeof OpenReport>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedFindings: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Links")).toBeVisible();
    await expect(page.getByText("okf.portability.relative-link")).toBeVisible();
    await expect(page.getByText(/never repairs authored files/i)).toBeVisible();
  },
};

export const Narrow: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Compatibility report")).toBeVisible();
    await expect(page.getByText(/review-operation\.md/)).toBeVisible();
  },
};
