import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";
import App from "./app";
import { AppProviders, initializeRendererDocument } from "./app-providers";

initializeRendererDocument();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <App />
      {process.env.NODE_ENV === "development" ? <Agentation /> : null}
    </AppProviders>
  </StrictMode>
);
