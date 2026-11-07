import { SourceControlProviderKind } from "@nodex/runtime-contracts";
import type { VcsStatusRemoteResult, VcsStatusResult } from "@nodex/runtime-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  formatGeneratedBranchName,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseOriginUrlFromGitConfig,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:Acme/Widgets.git")).toBe(
      "github.com/acme/widgets",
    );
    expect(normalizeGitRemoteUrl("https://github.com/Acme/Widgets.git")).toBe(
      "github.com/acme/widgets",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/Acme/Widgets")).toBe(
      "github.com/acme/widgets",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:Acme/platform/Widgets.git")).toBe(
      "gitlab.com/acme/platform/widgets",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/Acme/platform/Widgets.git")).toBe(
      "gitlab.com/acme/platform/widgets",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });

  it("normalizes SCP-like remotes with non-git SSH users", () => {
    expect(normalizeGitRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(
      "gitlab.example.com/group/project",
    );
    expect(normalizeGitRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(
      "bitbucket.org/workspace/repo",
    );
  });

  it("gives an Azure DevOps repository the same key over SSH as over HTTPS", () => {
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/Acme/Platform/Widgets")).toBe(
      "dev.azure.com/acme/platform/_git/widgets",
    );
    expect(normalizeGitRemoteUrl("ssh://git@ssh.dev.azure.com:22/v3/Acme/Platform/Widgets")).toBe(
      "dev.azure.com/acme/platform/_git/widgets",
    );
    expect(
      normalizeGitRemoteUrl("https://Acme@dev.azure.com/Acme/Platform/_git/Widgets"),
    ).toBe("dev.azure.com/acme/platform/_git/widgets");
  });

  it("puts the organization back in the host on the name dev.azure.com replaced", () => {
    expect(
      normalizeGitRemoteUrl("Acme@vs-ssh.visualstudio.com:v3/Acme/Platform/Widgets"),
    ).toBe("acme.visualstudio.com/platform/_git/widgets");
    expect(normalizeGitRemoteUrl("https://Acme.visualstudio.com/Platform/_git/Widgets")).toBe(
      "acme.visualstudio.com/platform/_git/widgets",
    );
  });

  it("leaves an Azure SSH host it cannot read as the path it was given", () => {
    // Not `v3`, and not four segments: rewriting either would invent a repository that the web
    // spelling has no name for, so the remote stands as it arrived.
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v4/Acme/Platform/Widgets")).toBe(
      "ssh.dev.azure.com/v4/acme/platform/widgets",
    );
    expect(normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/Acme/Widgets")).toBe(
      "ssh.dev.azure.com/v3/acme/widgets",
    );
  });
});

describe("parseOriginUrlFromGitConfig", () => {
  it("reads the origin url and ignores other remotes", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "upstream"]',
      "\turl = https://github.com/other/repo.git",
      '[remote "origin"]',
      "\turl = git@github.com:acme/widgets.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("git@github.com:acme/widgets.git");
  });

  it("strips inline comments and quotes from the url value", () => {
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/repo.git # mirror\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"]\n\turl = "git@github.com:acme/repo.git"\n'),
    ).toBe("git@github.com:acme/repo.git");
  });

  it("accepts legacy dotted headers, header comments, and line continuations", () => {
    expect(parseOriginUrlFromGitConfig("[remote.origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    // Git folds the dotted form to lowercase but keeps quoted names as written.
    expect(parseOriginUrlFromGitConfig("[remote.Origin]\n\turl = git@github.com:a/b.git\n")).toBe(
      "git@github.com:a/b.git",
    );
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "Origin"]\n\turl = git@github.com:x/y.git\n[remote "origin"]\n\turl = git@github.com:a/b.git\n',
      ),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig('[remote "origin"] # primary\n\turl = git@github.com:a/b.git\n'),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseOriginUrlFromGitConfig(
        '[remote "origin"]\n\turl = https://github.com/acme/\\\n\t\trepo.git\n',
      ),
    ).toBe("https://github.com/acme/repo.git");
  });

  it("falls back to the first remote when there is no origin", () => {
    const config = [
      '[remote "upstream"]',
      "\turl = https://github.com/acme/repo.git",
      '[remote "fork"]',
      "\turl = https://github.com/me/repo.git",
    ].join("\n");
    expect(parseOriginUrlFromGitConfig(config)).toBe("https://github.com/acme/repo.git");
  });

  it("returns null when there is no remote section", () => {
    expect(parseOriginUrlFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
    expect(parseOriginUrlFromGitConfig("")).toBeNull();
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:Acme/Widgets.git"),
    ).toBe("Acme/Widgets");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/Acme/Widgets.git"),
    ).toBe("Acme/Widgets");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://github.com/Acme/Widgets.git"),
    ).toBe("Acme/Widgets");
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: SourceControlProviderKind.make("github"),
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});

describe("sanitizeFeatureBranchName", () => {
  it.each(["feature", "fix", "team/jules"])("preserves the %s namespace", (namespace) => {
    expect(sanitizeFeatureBranchName(`${namespace}/refine-toolbar`)).toBe(
      `${namespace}/refine-toolbar`,
    );
  });

  it("sanitizes an explicit namespace before preserving it", () => {
    expect(sanitizeFeatureBranchName(' "FIX//Calendar recruitment filter" ')).toBe(
      "fix/calendar-recruitment-filter",
    );
  });

  it.each([
    ["refine toolbar", "feature/refine-toolbar"],
    ["", "feature/update"],
    [" /?. / ", "feature/update"],
    ["fix///", "feature/fix"],
  ])("keeps the fallback for unprefixed input %s", (input, expected) => {
    expect(sanitizeFeatureBranchName(input)).toBe(expected);
  });

  it("keeps the existing length limit for namespaced branches", () => {
    expect(sanitizeFeatureBranchName(`fix/${"x".repeat(80)}`)).toBe(`fix/${"x".repeat(60)}`);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("resolves case-insensitive collisions within the generated namespace", () => {
    expect(
      resolveAutoFeatureBranchName(
        ["FIX/refine-toolbar", "fix/refine-toolbar-2"],
        "fix/refine-toolbar",
      ),
    ).toBe("fix/refine-toolbar-3");
  });

  it("keeps the fallback when no preferred branch is supplied", () => {
    expect(resolveAutoFeatureBranchName(["feature/update"])).toBe("feature/update-2");
  });

  it.each([
    ["fix/name", ["fix"], "fix-2/name"],
    ["team/jules/fix/name", ["team/jules"], "team/jules-2/fix/name"],
    ["fix/name", ["fix/name/child"], "fix/name-2"],
    ["FIX/name", ["FIX", "FIX-2"], "fix-3/name"],
    ["fix/name", ["fixes", "fix/name-extra/child"], "fix/name"],
    [undefined, ["feature", "feature-2"], "feature-3/update"],
  ])("resolves %s against namespace blockers %j", (preferredBranch, existingNames, expected) => {
    expect(resolveAutoFeatureBranchName(existingNames, preferredBranch)).toBe(expected);
  });
});

describe("formatGeneratedBranchName", () => {
  it.each(["widgets", "widgets/"])("joins static prefix %s with one slash", (prefix) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe("widgets/add-search");
  });
  it("supports an empty prefix and preserves user prefix casing", () => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix: "", instructions: "" }),
    ).toBe("add-search");
    expect(
      formatGeneratedBranchName("Add Search", {
        mode: "static",
        prefix: "Team/Julius/",
        instructions: "",
      }),
    ).toBe("Team/Julius/add-search");
  });
  it.each([
    ["release..candidate", "release-candidate/add-search"],
    [" Team / Jules.lock/", "Team/Jules-lock/add-search"],
    ["-team//feature@{new}", "team/feature-new/add-search"],
    [" /?. / ", "add-search"],
  ])("normalizes invalid static prefix %s", (prefix, expected) => {
    expect(
      formatGeneratedBranchName("Add Search", { mode: "static", prefix, instructions: "" }),
    ).toBe(expected);
  });
  it("uses the model's semantic prefix without the stored static prefix", () => {
    expect(
      formatGeneratedBranchName("feat/Add Search", {
        mode: "semantic",
        prefix: "widgets",
        instructions: "",
      }),
    ).toBe("feat/add-search");
  });
  it("preserves the full custom name, including case, dots and length", () => {
    const branch = `Julius/ABC-123/release.v2-${"x".repeat(70)}`;
    expect(
      formatGeneratedBranchName(` ${branch} `, {
        mode: "custom",
        prefix: "ignored",
        instructions: "",
      }),
    ).toBe(branch);
  });
});
