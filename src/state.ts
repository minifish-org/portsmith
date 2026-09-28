import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicJson,
  copyFiles,
  readJson,
  snapshotFiles,
  hash,
} from "./files.js";
import { candidateFiles, fingerprint, loadTask } from "./workspace.js";
import { currentVerification } from "./verify.js";
import { loadPlan, planDigest } from "./plan.js";

export async function taskStatus(root: string) {
  const { task } = await loadTask(root);
  const files = await candidateFiles(root);
  const verification = await currentVerification(root);
  let state = files.some((f) => f.name.endsWith(".go"))
    ? "generated"
    : "prepared";
  if (verification)
    state = verification.current
      ? verification.report.status
      : "stale_verification";
  try {
    const acceptance = await readJson<{
      fingerprint: string;
      out: string;
      files: { name: string; sha256: string }[];
    }>(root, "acceptance.json");
    if (
      acceptance.fingerprint === (await fingerprint(root)) &&
      verification?.current &&
      verification.report.status === "behavior_verified"
    ) {
      const exported = await snapshotFiles(acceptance.out);
      const entries = exported
        .filter((f) => f.name !== "PORTSMITH-RECEIPT.json")
        .map(({ name, sha256 }) => ({ name, sha256 }));
      state =
        hash(JSON.stringify(entries)) === hash(JSON.stringify(acceptance.files))
          ? "accepted"
          : "export_changed";
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return {
    unit: task.unit,
    state,
    revision: task.revision,
    files: files.length,
    verification: verification?.current ?? false,
  };
}
export async function acceptTask(root: string, out: string) {
  const verification = await currentVerification(root);
  if (
    !verification?.current ||
    verification.report.status !== "behavior_verified"
  )
    throw new Error(
      "采纳需要当前候选通过独立行为验证；仅编译或候选自测通过不够",
    );
  const files = await candidateFiles(root);
  const digest = await fingerprint(root);
  const destination = path.resolve(out);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  await copyFiles(destination, files);
  const receipt = {
    at: new Date().toISOString(),
    fingerprint: digest,
    out: destination,
    files: files.map(({ name, sha256 }) => ({ name, sha256 })),
    verification: verification.report,
  };
  await atomicJson(path.join(destination, "PORTSMITH-RECEIPT.json"), receipt);
  await atomicJson(path.join(root, "acceptance.json"), receipt);
  return destination;
}
export async function planStatus(root: string, runs: string) {
  const plan = await loadPlan(root);
  const statuses = new Map<string, string>();
  const digest = await planDigest(root);
  for (const unit of plan.units) {
    try {
      const taskRoot = path.join(runs, unit.id);
      const status = await taskStatus(taskRoot);
      if (status.unit !== unit.id)
        throw new Error(`任务目录与unit不匹配：${unit.id}`);
      const { task } = await loadTask(taskRoot);
      statuses.set(
        unit.id,
        task.planDigest === digest ? status.state : "plan_changed",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        statuses.set(unit.id, "planned");
      else
        statuses.set(
          unit.id,
          `invalid: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
  }
  return plan.units.map((u) => ({
    unit: u.id,
    state: statuses.get(u.id)!,
    blockedBy: u.dependsOn.filter(
      (d) => !["behavior_verified", "accepted"].includes(statuses.get(d) ?? ""),
    ),
  }));
}
