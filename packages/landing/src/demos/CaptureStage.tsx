import type { Locale } from "../lib/locale";
import type { DemoProps } from "./demo-locale";
import AerialDemo from "./AerialDemo";
import AgentsDemo from "./AgentsDemo";
import { CAPTURE_DEMOS, type CaptureDemoId } from "./capture-demos";
import HeroDemo from "./HeroDemo";
import MobileDemo from "./MobileDemo";
import PagesDemo from "./PagesDemo";
import TidyDemo from "./TidyDemo";

const DEMOS: Record<CaptureDemoId, (props: DemoProps) => React.ReactNode> = {
  hero: ({ locale }) => <HeroDemo locale={locale} controls={false} />,
  aerial: AerialDemo,
  agents: AgentsDemo,
  pages: PagesDemo,
  tidy: TidyDemo,
  mobile: MobileDemo,
};

/** One demo alone at its designed size, for recording README and social media. */
export default function CaptureStage({
  demo,
  locale,
}: {
  readonly demo: CaptureDemoId;
  readonly locale: Locale;
}) {
  const size = CAPTURE_DEMOS[demo];
  const Demo = DEMOS[demo];
  return (
    <div data-capture-root className="p-10" style={{ width: size.width + 80 }}>
      <Demo locale={locale} />
    </div>
  );
}
