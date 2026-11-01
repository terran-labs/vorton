import { WorkspaceApp } from "../workspace";
import { LastResortTools } from "../tools/last-resort-tools";
import type { ApplicationRoute } from "./application";

export default function LastResortScreen({ route }: { route: ApplicationRoute }) {
  return <WorkspaceApp profile="LastResort" page={route.page} forgeView={route.forgeView} adminSection={route.adminSection} renderTools={({ draftTask }) => <LastResortTools onDraftTask={draftTask}/>}/>;
}
