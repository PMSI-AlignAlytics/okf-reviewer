import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpenText, Palette, Settings2, UserRound } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  SettingRow,
  SettingsGroup,
  SettingsWorkspace,
} from "./SettingsWorkspace.tsx";
import type {
  SettingsNavigationItem,
  SettingsSectionId,
} from "./SettingsWorkspace.tsx";
import "./Settings.css";

const sections = [
  { id: "general", label: "General", description: "Local bundle discovery.", icon: Settings2 },
  { id: "appearance", label: "Appearance", description: "Theme and motion.", icon: Palette },
  { id: "reading", label: "Reading", description: "Reader preferences.", icon: BookOpenText },
  { id: "reviewer", label: "Reviewer", description: "Human review identity.", icon: UserRound },
] as const satisfies readonly SettingsNavigationItem[];

function WorkspaceStory() {
  const [section, setSection] = useState<SettingsSectionId>("general");
  const active = sections.find((item) => item.id === section) ?? sections[0];
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className="ui-dialog settings-dialog">
          <SettingsWorkspace
            sections={sections}
            activeSection={section}
            query=""
            resultCount={0}
            onQueryChange={() => undefined}
            onSectionChange={setSection}
            onReset={() => undefined}
          >
            <SettingsGroup title={active.label} description={active.description}>
              <SettingRow
                title="Example preference"
                description="A local preference row."
                control={<button type="button">Change</button>}
              />
            </SettingsGroup>
          </SettingsWorkspace>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const meta = {
  title: "Shell/Settings/Workspace",
  component: WorkspaceStory,
} satisfies Meta<typeof WorkspaceStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
