import AgentsDemo from "./AgentsDemo";
import { CAPTURE_DEMOS, type CaptureDemoId } from "./capture-demos";
import FanOutDemo from "./FanOutDemo";
import HeroDemo from "./HeroDemo";
import PagesDemo from "./PagesDemo";
import TidyDemo from "./TidyDemo";

const DEMOS: Record<CaptureDemoId, () => React.ReactNode> = {
  hero: () => <HeroDemo controls={false} />,
  fanout: () => <FanOutDemo />,
  agents: () => <AgentsDemo />,
  pages: () => <PagesDemo />,
  tidy: () => <TidyDemo />,
};

/** One demo alone at its designed size, for recording README and social media. */
export default function CaptureStage({ demo }: { readonly demo: CaptureDemoId }) {
  const size = CAPTURE_DEMOS[demo];
  return (
    <div data-capture-root className="p-10" style={{ width: size.width + 80 }}>
      {DEMOS[demo]()}
    </div>
  );
}
