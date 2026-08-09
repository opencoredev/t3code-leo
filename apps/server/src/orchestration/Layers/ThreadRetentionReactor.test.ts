import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  makeRetentionCandidateQuery,
  RETENTION_SCAN_PAGE_SIZE,
  retentionCutoff,
} from "./ThreadRetentionReactor.ts";

const CUTOFF = "2026-01-01T00:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const RECENT = "2026-06-01T00:00:00.000Z";

const insertThread = (
  sql: SqlClient.SqlClient,
  row: {
    readonly threadId: string;
    readonly settledOverride?: string | null;
    readonly settledAt?: string | null;
    readonly deletedAt?: string | null;
    readonly archivedAt?: string | null;
    readonly pinnedAt?: string | null;
    readonly snoozedUntil?: string | null;
  },
) =>
  sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, created_at, updated_at,
      settled_override, settled_at, deleted_at, archived_at, pinned_at, snoozed_until
    ) VALUES (
      ${row.threadId}, 'project-1', 'Thread', '{"instanceId":"codex","model":"gpt-5.4"}', ${OLD}, ${OLD},
      ${row.settledOverride ?? "settled"}, ${row.settledAt ?? OLD},
      ${row.deletedAt ?? null}, ${row.archivedAt ?? null},
      ${row.pinnedAt ?? null}, ${row.snoozedUntil ?? null}
    )
  `;

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("thread retention candidate scan", (it) => {
  it.effect("returns only settled threads with no lifecycle blocker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({});

      yield* insertThread(sql, { threadId: "eligible" });
      yield* insertThread(sql, { threadId: "active", settledOverride: "active", settledAt: null });
      yield* insertThread(sql, { threadId: "recent", settledAt: RECENT });
      yield* insertThread(sql, { threadId: "deleted", deletedAt: OLD });
      yield* insertThread(sql, { threadId: "archived", archivedAt: OLD });
      yield* insertThread(sql, { threadId: "pinned", pinnedAt: OLD });
      yield* insertThread(sql, { threadId: "snoozed", snoozedUntil: RECENT });

      const candidates = yield* makeRetentionCandidateQuery(sql)({ cutoff: CUTOFF });
      assert.deepStrictEqual(
        candidates.map((candidate) => candidate.threadId),
        ["eligible"],
      );
      assert.strictEqual(candidates[0]?.settledAt, OLD);
    }),
  );

  it.effect("bounds one scan to a single page", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({});

      for (let index = 0; index < RETENTION_SCAN_PAGE_SIZE + 5; index += 1) {
        yield* insertThread(sql, { threadId: `thread-${index}` });
      }

      const candidates = yield* makeRetentionCandidateQuery(sql)({ cutoff: CUTOFF });
      assert.strictEqual(candidates.length, RETENTION_SCAN_PAGE_SIZE);
    }),
  );
});

it("computes one cutoff per scan from the retention window", () => {
  const now = Date.parse("2026-01-31T00:00:00.000Z");
  assert.strictEqual(retentionCutoff(30, now), "2026-01-01T00:00:00.000Z");
  assert.strictEqual(retentionCutoff(1, now), "2026-01-30T00:00:00.000Z");
});
