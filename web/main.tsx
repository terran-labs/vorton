import { createRoot } from "react-dom/client";
import { lazyView } from "./application/lazy-view";
import { LoadingIndicator } from "./loading-indicator";
import { Application, type ApplicationRegistration } from "./application/application";
import { nativeRoute } from "./application/routes";
import { initializeAppearance } from "./design/appearance-startup";
import { workspaceLinks } from "./application/workspace-navigation";
import "./design/themes.css";
import "./design/workspace-shell.css";
import "./design/fonts.css";
import "./design/theme-preview.css";
import "./design/menu-selection.css";
import "./demo-shell.css";

const loadScreen = () => import("./application/last-resort-screen");
const registration: ApplicationRegistration = {
  variant: "portable",
  profiles: ["LastResort"], defaultProfile: "LastResort",
  resolve: pathname => {
    const route = nativeRoute(pathname, "LastResort");
    return route ? { ...route, title: `The Last Resort · ${route.page[0].toUpperCase() + route.page.slice(1)}` } : null;
  },
  links: workspaceLinks,
  Screen: lazyView(loadScreen, { loading: ({ error, retry }) => error ? <section role="alert"><h1>Workspace unavailable</h1><p>{error.message}</p><button onClick={retry}>Retry</button></section> : <LoadingIndicator label="Opening workspace"/> }),
  prefetch: () => { void loadScreen().catch(() => {}); },
};
initializeAppearance();
const root = document.getElementById("root");
if (root) createRoot(root).render(<Application registration={registration}/>);
