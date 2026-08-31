import { serializeInlineContent } from "./nfm";
import { DEFAULT_PROJECT_APPEARANCE } from "./project-appearance";

export const INITIAL_PROJECT_NAME = "My Project";
export const INITIAL_PROJECT_DESCRIPTION = "";
export const INITIAL_PROJECT_APPEARANCE = DEFAULT_PROJECT_APPEARANCE;
export const INITIAL_PROJECT_FOLDER_BASENAME = "My Project";
export const INITIAL_PROJECT_WELCOME_TITLE = "Welcome to Nodex";

const MAX_SOURCE_ROOT_BYTES = 4_096;

export interface InitialProjectWelcomePage {
  readonly titleMarkdown: typeof INITIAL_PROJECT_WELCOME_TITLE;
  readonly nfm: string;
}

export interface InitialProjectPresentation {
  readonly projectId: string;
  readonly defaultDatabaseViewId: string;
  readonly starterPageId: string;
  readonly starterPageTitle: string;
}

export function renderInitialProjectWelcomePage(input: {
  readonly sourceRoot: string;
}): InitialProjectWelcomePage {
  if (
    input.sourceRoot.length === 0 ||
    input.sourceRoot.length > MAX_SOURCE_ROOT_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(input.sourceRoot)
  ) {
    throw new Error("Initial Project source root must be one bounded path");
  }

  const sourceRoot = serializeInlineContent([
    {
      type: "text",
      text: input.sourceRoot,
      styles: { code: true },
    },
  ]);
  const projectName = serializeInlineContent([
    {
      type: "text",
      text: INITIAL_PROJECT_NAME,
      styles: { bold: true },
    },
  ]);

  return {
    titleMarkdown: INITIAL_PROJECT_WELCOME_TITLE,
    nfm: [
      `Welcome to ${projectName}. It’s a regular Nodex Project, already connected to the source folder below. Rename the Project, add folders, or delete this Page whenever you’re ready.`,
      '<callout icon="📁">',
      `\t**Source folder:** ${sourceRoot}`,
      "\tAgents in this Project can work in the ordered source folders shown in **Edit project**.",
      "</callout>",
      "<empty-block/>",
      "## Connect your model",
      "Use **Sign in** at the bottom of the sidebar to connect ChatGPT. Available Codex models then appear in the chat composer.",
      "<empty-block/>",
      "## Try your first task",
      "Select the prompt block below, choose **Send to chat**, then choose **New chat**.",
      "> Create a file named `hello-nodex.md` in this Project’s source folder with a short welcome note. Then tell me exactly what you changed.",
      "<empty-block/>",
      "## A quick tour",
      "- **Projects** group chats and ordered source folders. Use **+** next to Projects to create another Project and choose your own folders.",
      "- **Projectless chats** are for work that should not belong to a Project; Nodex gives each one a managed workspace.",
      "- **Pages** are durable, editable block documents. This Page is also a row in this Project’s primary Database.",
      "- **DB Views** organize Pages with properties, filters, groups, and different views without changing the Page itself.",
      "<empty-block/>",
      "▶ Explore next",
      "\t- Open **Database** in the tab bar to see this Page as structured data.",
      "\t- Edit this Page or create another Page and organize it in a DB View.",
      "\t- Start a Project chat from the prompt above.",
      "\t- Start a Projectless chat when you do not want Project ownership.",
      "\t- Initialize Git in the source folder when you want to use worktree chats.",
    ].join("\n"),
  };
}
