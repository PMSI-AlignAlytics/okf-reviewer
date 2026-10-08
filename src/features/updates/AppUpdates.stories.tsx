import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { expect, waitFor, within } from "storybook/test";
import { WithStore } from "@/mock/withStore.tsx";
import { AppUpdates, AppUpdatesSettings } from "./AppUpdates.tsx";
import { UpdateController } from "./controller.ts";

function UpdateExample({ mode }: { mode: "available" | "downloading" | "offline" }) {
  const [controller] = useState(() => new UpdateController({
    check: () => mode === "offline" ? Promise.reject(new Error("Could not check for updates: connection unavailable."))
      : Promise.resolve({ supported: true, installation: "nsis", update: { version: "1.2.3", notes: "Improved bundle navigation and review controls." } }),
    download: (_version, progress) => {
      progress({ downloaded: 64, total: 100 });
      return new Promise<void>(() => { /* Keep the download visible in this story. */ });
    },
    install: () => Promise.resolve(),
  }));
  useEffect(() => {
    void controller.check().then(() => {
      if (mode === "downloading") void controller.install(() => Promise.resolve());
    });
  }, [controller, mode]);
  return (
    <WithStore>
      <div className="app">
        <AppUpdates controller={controller} />
        <div style={{ padding: "var(--space-24)", maxWidth: "800px" }}><AppUpdatesSettings controller={controller} /></div>
      </div>
    </WithStore>
  );
}

const meta = { title: "Shell/Application updates", component: UpdateExample } satisfies Meta<typeof UpdateExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  args: { mode: "available" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("complementary", { name: "Application update" })).resolves.toBeVisible();
  },
};

export const Downloading: Story = {
  args: { mode: "downloading" },
  play: async () => {
    const body = within(document.body);
    const dialog = await body.findByRole("dialog", { name: "Downloading update" });
    await waitFor(() => expect(dialog).toBeVisible());
    const bounds = dialog.getBoundingClientRect();
    await expect(bounds.top).toBeGreaterThanOrEqual(0);
    await expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    await expect(body.getByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "64");
  },
};

export const Offline: Story = {
  args: { mode: "offline" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole("alert")).resolves.toHaveTextContent("connection unavailable");
  },
};
