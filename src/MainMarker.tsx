// MM1 (@ui-bois): decorative Main project pin marker (@art public/ui/main-marker.json: 3-frame strip, idle + 2 blink frames).
// Skip-if-absent: renders nothing until the sheet loads, so a missing PNG leaves the Main row exactly as before.
import "./MainMarker.css";
import { integerSheetSrc } from "./pins";
import { snapDeviceSize, useUiScale } from "./uiScale";
import { useDpr, useImageOk, useTheme } from "./useBotFace";

export function mainMarkerSheetSrc(theme: string, devicePx = 32): string {
  return integerSheetSrc(`/ui/main-marker-${theme === "light" ? "light" : "dark"}`, devicePx);
}

export function MainMarker() {
  const theme = useTheme();
  const { device, css } = snapDeviceSize(16, 16, useDpr(), useUiScale());
  const sheet = mainMarkerSheetSrc(theme, device);
  const ok = useImageOk(sheet);
  if (!ok) return null;
  return <span className="boring-main-marker" data-testid="boring-main-marker" aria-hidden="true" style={{ backgroundImage: `url(${sheet})`, width: css, height: css }} />;
}
