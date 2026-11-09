// Chips C2 (docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md): the Perfection angel at the top of the Usage panel, in the same CRT bezel as the
// sky-god TVs (SkyZones' FaceStage + bezel hook; no new layout). Clicking her opens the Perfection (Workflows) lane. When the bezel is
// narrower than the panel the sides are the cloud strip (sky-clouds.json), drawn at the face's integer scale.
import { useState } from "react";
import type { PinHandler } from "./PinGrid";
import { showPinToast } from "./PinIdeas";
import type { Pin } from "./pins";
import { FaceStage, useSkyBezel } from "./SkyZones";
import { cloudStripStyle, faceBg, SKY_CLOUDS_URL } from "./skyZonesLogic";
import { useBotFace, useDpr, useFacesModel, useImageOk, usePrefersReducedMotion, useSkyCloudsModel, useTheme } from "./useBotFace";

const NAME = "Perfection";

export function AngelBezel({ pin, onOpen }: { pin: Pin | null; onOpen?: PinHandler }) {
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const dpr = useDpr();
  const faces = useFacesModel();
  const clouds = useSkyCloudsModel();
  const cloudsOk = useImageOk(clouds ? SKY_CLOUDS_URL(theme) : null);
  const { frameStyle } = useSkyBezel();
  const [hover, setHover] = useState(false);
  const [k, setK] = useState(0);
  // Reduced motion = the idle frame only (no hover frames either).
  const face = useBotFace("angel", null, faces, { theme, reduced, force: hover && !reduced ? "hover" : null });
  const can = !!pin && !!onOpen;
  const label = can ? `Open the ${NAME} lane` : `${NAME} lane not set up`;
  // The cloud tile is drawn at the face's own scale (reported by FaceStage); until the face is measured, the colour only.
  const strip = clouds ? cloudStripStyle(clouds, theme, k, cloudsOk ? SKY_CLOUDS_URL(theme) : null) : undefined;
  return (
    <div className="angel-strip" data-testid="angel-strip" data-has-clouds={clouds ? "true" : "false"} style={strip}>
      <section className={`sky-zone angel-bezel${frameStyle ? " has-frame" : ""}`} style={frameStyle ?? undefined} data-testid="angel-bezel" aria-label={`${NAME} angel`}>
        <FaceStage testBot="angel" shown="angel" faces={faces} face={face} bg={faceBg(faces, "angel", theme)} onScale={setK} />
        <button
          type="button"
          className="sky-face-hit angel-hit"
          data-testid="angel-hit"
          aria-label={label}
          disabled={!can}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onFocus={() => setHover(true)}
          onBlur={() => setHover(false)}
          onClick={() => {
            if (pin && onOpen) void Promise.resolve(onOpen(pin)).catch((err) => showPinToast(`Could not open ${pin.lane.name}: ${err}`));
          }}
        />
        <span className="sky-crt-name" data-testid="angel-name">
          <span className="sky-crt-name-text">{NAME}</span>
        </span>
      </section>
    </div>
  );
}
