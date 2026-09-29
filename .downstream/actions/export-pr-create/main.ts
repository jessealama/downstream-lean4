import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getInput, getInputOpt, parseBool, parseRepo } from "../lib/input";
import type { BuildReport } from "../lib/reports";
import {
  abort,
  assert,
  captureIn,
  exit,
  findPrFor,
  Repo,
  runIn,
} from "../lib/util";

type Method = "same-branch" | "target-branch";

function parseMethod(input: string): Method {
  assert(
    input === "same-branch" || input === "target-branch",
    `Invalid method "${input}"`,
  );
  return input;
}

function parseLakefileEdits(input: string): [string, string][] {
  const edits: [string, string][] = [];
  for (const line of input.split("\n")) {
    if (line.trim() === "") continue;
    const i = line.indexOf(" -> ");
    assert(i >= 0, `Expected "pattern -> replacement", not "${line}"`);
    edits.push([line.slice(0, i), line.slice(i + " -> ".length)]);
  }
  return edits;
}

const subrepo = getInput("subrepo");
const buildReportPath = getInput("build-report-path");
const clonePath = getInput("clone-path");
const trackingBranch = getInputOpt("tracking-branch") ?? `export/${subrepo}`;
const method = getInput("method", parseMethod);
// Downstream repo
const downstreamRepo = getInput("downstream-repo", parseRepo);
const downstreamToken = getInput("downstream-token");
// Source repo
const sourceRepo = getInput("source-repo", parseRepo);
const sourceToken = getInput("source-token");
// Target repo
const targetRepo = getInputOpt("target-repo", parseRepo) ?? sourceRepo;
const targetBranch = getInput("target-branch");
const targetToken = getInputOpt("target-token") ?? sourceToken;
// Export PRs
const pr = getInput("pr", parseBool);
const prRepo = getInputOpt("pr-repo", parseRepo) ?? targetRepo;
const prBranch = getInputOpt("pr-branch") ?? `${downstreamRepo.repo}-export`;
const prToken = getInputOpt("pr-token") ?? targetToken;
const prTitle =
  getInputOpt("pr-title") ?? `chore: adaptations from ${downstreamRepo.repo}`;
const prBody = getInputOpt("pr-body");
const prExplanation = getInputOpt("pr-explanation");
// Export options
const updateToolchains = getInput("update-toolchains", parseBool);
const lakefileEdits = getInputOpt("lakefile-edits", parseLakefileEdits) ?? [];
const updateManifests = getInput("update-manifests", parseBool);

core.setSecret(downstreamToken);
core.setSecret(sourceToken);
core.setSecret(targetToken);
core.setSecret(prToken);

const targetOcto = github.getOctokit(targetToken);

const cRun = runIn(clonePath);
const cCapture = captureIn(clonePath);

function scriptPath(name: string): string {
  return path.resolve(__dirname, "../../..", name);
}

function authUrl(token: string, repo: Repo): string {
  return `https://x-access-token:${token}@github.com/${repo.fullName}.git`;
}

async function loadBuildReport(): Promise<BuildReport> {
  const raw = await fs.readFile(buildReportPath, "utf8");
  return JSON.parse(raw) as BuildReport;
}

function isBuildReportGreen(report: BuildReport): boolean {
  const repoEntry = report.repos.find((r) => r.name === subrepo);
  return repoEntry?.green ?? false;
}

async function findExportPr(): Promise<number | null> {
  const pr = await findPrFor(targetOcto, targetRepo, prBranch, {
    state: "open",
    headOwner: prRepo.owner,
  });
  return pr?.number ?? null;
}

// Clone the downstream repo as a blobless partial clone with full history.
async function cloneDownstreamRepo(): Promise<void> {
  core.info(`Cloning ${downstreamRepo.fullName}...`);
  await exec.exec("git", [
    ...["clone", "--quiet", "--filter=blob:none", "--no-checkout"],
    ...[authUrl(downstreamToken, downstreamRepo), clonePath],
  ]);
}

// Check whether the tracking branch is a true ancestor (i.e. not identical to)
// the specified commit hash. If the tracking branch does not exist yet (e.g. on
// the first export), we treat it as an ancestor.
async function trackingBranchIsTrueAncestor(sha: string): Promise<boolean> {
  const verifyExitCode = await cRun(
    "git",
    ["rev-parse", "--verify", "--quiet", `origin/${trackingBranch}`],
    { ignoreReturnCode: true, silent: true },
  );
  if (verifyExitCode !== 0) return true;

  const trackingSha = await cCapture("git", [
    "rev-parse",
    `origin/${trackingBranch}`,
  ]);
  if (trackingSha === sha) return false;

  const exitCode = await cRun(
    "git",
    ["merge-base", "--is-ancestor", trackingSha, sha],
    { ignoreReturnCode: true },
  );
  return exitCode === 0;
}

type BaseCommit = {
  repo: string;
  url: string;
  rev: string;
  sha: string;
};

async function findBaseCommit(): Promise<BaseCommit> {
  const result = await cCapture(scriptPath("internal_find_base_commit.py"), [
    ".",
    subrepo,
  ]);
  return JSON.parse(result) as BaseCommit;
}

// The subrepo's rev from repos.toml, i.e. its current source branch.
async function findSourceRev(): Promise<string> {
  const result = await cCapture(scriptPath("list.py"), [
    ...[".", subrepo, "--json"],
  ]);
  assert(result !== "", `Subrepo ${subrepo} not found in repos.toml`);
  return (JSON.parse(result) as { rev: string }).rev;
}

// Fetch parts of a repo. Uses a blobless partial clone with full history since
// we may need to create merge commits. Returns the fetched sha.
async function fetchFromRepo(
  repo: Repo,
  token: string,
  revOrSha: string,
): Promise<string> {
  core.info(`Fetching ${revOrSha} from ${repo.fullName}...`);
  await cRun("git", [
    ...["fetch", "--quiet", "--filter=blob:none"],
    ...[authUrl(token, repo), revOrSha],
  ]);
  return await cCapture("git", [
    ...["rev-parse", "--verify", "--quiet"],
    "FETCH_HEAD^{commit}",
  ]);
}

async function pushToRepo(
  repo: Repo,
  token: string,
  sha: string,
  branch: string,
  force: boolean = false,
): Promise<void> {
  await cRun("git", [
    "push",
    ...(force ? ["--force"] : []),
    authUrl(token, repo),
    `${sha}:refs/heads/${branch}`,
  ]);
}

function isNonemptyExport(exitCode: number): boolean {
  if (exitCode === 10 /* EXIT_EMPTY */) {
    return false; // Exit code returned by --fail-if-empty when empty
  } else if (exitCode === 0) {
    return true; // Successful export, so there are changes
  } else {
    abort(`export.py exited with code ${exitCode}`);
  }
}

async function runExport(onto: string): Promise<boolean> {
  const exitCode = await cRun(
    scriptPath("export.py"),
    [
      ...[".", subrepo, "--fail-if-empty"],
      ...["--onto", onto],
      ...["--message", prTitle],
      ...(updateToolchains ? ["--update-toolchains"] : []),
      ...lakefileEdits.flatMap(([p, r]) => ["--edit-lakefile", p, r]),
      ...(updateManifests ? ["--update-manifests"] : []),
    ],
    { ignoreReturnCode: true },
  );

  return isNonemptyExport(exitCode);
}

async function updateSubrepo(sha: string): Promise<string | null> {
  await cRun("git", ["switch", "--detach", sha]);

  // Fetch both commits ourselves, update.py would fetch them shallowly.
  const baseCommit = await findBaseCommit();
  const sourceRev = await findSourceRev();

  await fetchFromRepo(sourceRepo, sourceToken, baseCommit.sha);
  const sourceSha = await fetchFromRepo(sourceRepo, sourceToken, sourceRev);

  await cRun(scriptPath("update.py"), [
    ...[".", "--update", subrepo, "--update-to", subrepo, sourceSha],
  ]);
  const exitCode = await cRun("git", ["diff", "--quiet", sha, "HEAD"], {
    ignoreReturnCode: true,
  });
  if (exitCode !== 0) return null;
  return await cCapture("git", ["rev-parse", "HEAD"]);
}

async function exportSameBranch(sha: string): Promise<boolean> {
  await cRun("git", ["switch", "--detach", sha]);
  const baseCommit = await findBaseCommit();
  const baseSha = await fetchFromRepo(sourceRepo, sourceToken, baseCommit.sha);
  return await runExport(baseSha);
}

async function exportTargetBranch(sha: string): Promise<boolean> {
  await cRun("git", ["switch", "--detach", sha]);
  const baseCommit = await findBaseCommit();
  // Make sure to fetch both, else the merge may fail to find the sha
  const baseSha = await fetchFromRepo(sourceRepo, sourceToken, baseCommit.sha);
  const targetSha = await fetchFromRepo(targetRepo, targetToken, targetBranch);

  // Merge source branch, resolving conflicts in favor of the source branch
  await cRun("git", ["switch", "--detach", targetSha]);
  await cRun("git", [
    ...["merge", "--strategy-option=theirs", baseSha],
    ...["-m", `chore: merge '${baseCommit.rev}'`],
  ]);
  const mergeSha = await cCapture("git", ["rev-parse", "HEAD"]);

  // Export downstream changes on top
  await cRun("git", ["switch", "--detach", sha]);
  const nonempty = await runExport(mergeSha);

  // Push merge commit now, to prepare the branch for the export PR
  if (nonempty && pr)
    await pushToRepo(targetRepo, targetToken, mergeSha, targetBranch);

  return nonempty;
}

async function createExportPr(): Promise<number> {
  await pushToRepo(prRepo, prToken, "HEAD", prBranch, true);

  let body = prBody ?? "";
  if (prExplanation) body += `\n\n${prExplanation}`;

  const { data } = await targetOcto.rest.pulls.create({
    ...targetRepo,
    base: targetBranch,
    head: `${prRepo.owner}:${prBranch}`,
    title: prTitle,
    body,
  });

  return data.number;
}

async function run(): Promise<void> {
  core.setOutput("pr-created", false);

  // Don't export broken changes.
  const buildReport = await loadBuildReport();
  if (!isBuildReportGreen(buildReport))
    exit("Build report is not green, stopping.");

  // Don't export if a PR already exists.
  if (pr) {
    const prNumber = await findExportPr();
    if (prNumber !== null) {
      core.setOutput("pr-number", prNumber);
      exit(`Export PR #${prNumber} already exists, stopping.`);
    }
  }

  // Delay cloning downstream repo until now since it can be expensive.
  await cloneDownstreamRepo();

  // The tracking branch is used to avoid out-of-order exports and to avoid
  // unnecessary work.
  const isAncestor = await trackingBranchIsTrueAncestor(buildReport.commit_sha);
  if (!isAncestor) exit(`Tracking branch ${trackingBranch} too new, stopping.`);

  // Ensure there are no relevant upstream changes since our last update,
  // otherwise we'd sometimes do unnecessary work like opening a new export PR
  // immediately after the last one was merged.
  const updatedSha = await updateSubrepo(buildReport.commit_sha);
  if (updatedSha === null) exit(`Subrepo ${subrepo} is outdated, stopping.`);

  const nonempty =
    method === "same-branch"
      ? await exportSameBranch(updatedSha)
      : await exportTargetBranch(updatedSha);

  // Create export PR or push to target branch, depending on settings
  if (nonempty) {
    if (pr) {
      const prNumber = await createExportPr();
      core.setOutput("pr-created", true);
      core.setOutput("pr-number", prNumber);
    } else {
      await pushToRepo(targetRepo, targetToken, "HEAD", targetBranch);
    }
  }

  // Advance tracking branch
  await pushToRepo(
    downstreamRepo,
    downstreamToken,
    buildReport.commit_sha,
    trackingBranch,
  );
}

run().catch((error) => {
  abort(error instanceof Error ? error.message : String(error));
});
