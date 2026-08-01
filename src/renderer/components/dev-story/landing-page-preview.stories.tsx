import type { Meta, StoryObj } from "@storybook/react-vite";

type LandingPreviewProps = {
  viewport: "desktop" | "mobile";
};

const landingPreviewUrl = import.meta.env.VITE_LANDING_PREVIEW_URL ?? "http://127.0.0.1:4321/";

function LandingPreview({ viewport }: LandingPreviewProps) {
  const mobile = viewport === "mobile";

  return (
    <div className="fixed inset-0 overflow-auto bg-[#f2f0e3] p-0">
      <div
        className={
          mobile
            ? "mx-auto min-h-full w-[390px] max-w-full bg-[#f2f0e3]"
            : "h-full w-full bg-[#f2f0e3]"
        }
      >
        <iframe
          className="block h-full min-h-[844px] w-full border-0 bg-[#f2f0e3]"
          sandbox="allow-downloads allow-forms allow-popups allow-scripts"
          src={landingPreviewUrl}
          title={`Nodex landing page ${viewport} preview`}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Landing/Page preview",
  component: LandingPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production-backed desktop and mobile review of the Astro landing page, including its single-action hero, responsive header, core values, and footer. Start `vp run preview:landing` first; override the URL with VITE_LANDING_PREVIEW_URL when needed.",
      },
    },
  },
  args: {
    viewport: "desktop",
  },
  argTypes: {
    viewport: {
      control: "inline-radio",
      options: ["desktop", "mobile"],
    },
  },
} satisfies Meta<typeof LandingPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const Mobile: Story = {
  args: {
    viewport: "mobile",
  },
};
