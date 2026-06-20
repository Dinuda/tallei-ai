import { CanvasEmailRenderer } from "./renderer";
import { registerRenderer } from "../registry";

registerRenderer({
  kind: "canvas.email",
  label: "Email",
  displayMode: "inline",
  component: CanvasEmailRenderer,
});

registerRenderer({
  kind: "canvas.preview",
  label: "Email",
  displayMode: "inline",
  component: CanvasEmailRenderer,
});

registerRenderer({
  kind: "canvas_email",
  label: "Email",
  displayMode: "inline",
  component: CanvasEmailRenderer,
});

registerRenderer({
  kind: "canvas_preview",
  label: "Email",
  displayMode: "inline",
  component: CanvasEmailRenderer,
});
