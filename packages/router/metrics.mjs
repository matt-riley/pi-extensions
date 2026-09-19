// metrics.mjs — what the router actually costs and gets right.
//
// The audit's sharpest criticism was that switching was never priced: the code
// claimed cache awareness without measuring a cold prefill. These are the
// measurements that can be taken from data already on disk — request usage,
// model changes, and the router's own decision entries.
//
// Everything here is arithmetic over recorded facts. Two things it deliberately
// does not claim:
//
//   - A counterfactual cost is an estimate. It prices the same tokens at the
//     session's other model's rates; it does not know what would have happened.
//   - Quality is not measured. Cheaper answers are not scored against expensive
//     ones, so a cost saving is not evidence of a good decision.

/** Does a "provider/model" key match any frontier pattern? */
export function isFrontierModel(key, patterns) {
  const value = String(key ?? "").toLowerCase();
  if (!value) return false;
  return (patterns ?? []).some((pattern) => value.includes(String(pattern).toLowerCase()));
}

/**
 * Every request in a session, flattened in order.
 *
 * Requests are the unit that costs money and the unit that carries a model, so
 * episodes and switch costs are computed here rather than per turn.
 */
export function requestSeries(session) {
  const series = [];
  for (const [turnIndex, turn] of (session?.turns ?? []).entries()) {
    const failures = (turn.toolCalls ?? []).filter((call) => call.isError).length;
    for (const request of turn.requests ?? []) {
      series.push({
        turnIndex,
        model: request.model,
        context: request.context,
        freshInput: request.input,
        cacheRead: request.cacheRead,
        cacheWrite: request.cacheWrite,
        output: request.output,
        cost: request.cost?.total ?? 0,
        failures,
        prompt: turn.prompt,
      });
    }
  }
  return series;
}

/** Indices where the model differs from the previous request's. */
export function switchPoints(series) {
  const points = [];
  for (let i = 1; i < (series?.length ?? 0); i++) {
    if (series[i].model !== series[i - 1].model) points.push(i);
  }
  return points;
}

/**
 * What each model switch cost, in cold tokens and dollars.
 *
 * `coldTokens` is what the destination had to read at full price — fresh input
 * plus whatever it wrote to its cache. `rewarmRequests` counts requests until
 * the destination is mostly reading from cache again, which is the honest
 * measure of "how long until this switch stopped hurting".
 */
export function switchCosts(series, points = switchPoints(series)) {
  return points.map((index) => {
    const at = series[index];
    let rewarm = null;
    for (let i = index; i < series.length; i++) {
      const read = series[i].cacheRead;
      const context = series[i].context || 1;
      if (i > index && read / context >= 0.5) {
        rewarm = i - index;
        break;
      }
    }
    return {
      index,
      from: series[index - 1].model,
      to: at.model,
      coldTokens: at.freshInput + at.cacheWrite,
      coldCost: at.cost,
      context: at.context,
      rewarmRequests: rewarm,
      prompt: at.prompt,
    };
  });
}

/**
 * Contiguous runs of requests served by a frontier model.
 *
 * `baselinePerRequest` is the same session's median cost per request on other
 * models, so the delta compares like with like inside one workload rather than
 * across sessions with different sizes.
 */
export function frontierEpisodes(session, { patterns, minRequests = 1 } = {}) {
  const series = requestSeries(session);
  const baseline = median(
    series
      .filter((request) => !isFrontierModel(request.model, patterns))
      .map((request) => request.cost),
  );

  const episodes = [];
  let current = null;
  for (const request of series) {
    const frontier = isFrontierModel(request.model, patterns);
    if (!frontier) {
      if (current) episodes.push(current);
      current = null;
      continue;
    }
    if (!current) {
      current = {
        model: request.model,
        requests: 0,
        cost: 0,
        context: request.context,
        failures: 0,
        turnsWithFailures: 0,
        contextRead: 0,
        cachedRead: 0,
        turns: new Set(),
        firstPrompt: request.prompt,
        startContext: request.context,
      };
    }
    current.requests++;
    current.cost += request.cost;
    current.contextRead += request.context;
    current.cachedRead += request.cacheRead;
    // A turn's failure count is copied onto each of its requests, so adding it
    // per request multiplies it — the first version of this reported a 216%
    // failure rate. Count each turn once.
    if (!current.turns.has(request.turnIndex)) {
      current.turns.add(request.turnIndex);
      current.failures += request.failures;
      if (request.failures > 0) current.turnsWithFailures++;
    }
  }
  if (current) episodes.push(current);

  return episodes
    .filter((episode) => episode.requests >= minRequests)
    .map((episode) => ({
      ...episode,
      turns: episode.turns.size,
      perRequest: episode.requests ? episode.cost / episode.requests : 0,
      failuresPerTurn: episode.turns.size ? episode.failures / episode.turns.size : 0,
      // The same shape as the corpus baseline: the share of turns in which at
      // least one tool call failed. Comparing this with a failures-per-turn
      // ratio would be comparing two different measurements.
      failureShare: episode.turns.size ? episode.turnsWithFailures / episode.turns.size : 0,
      cacheShare: episode.contextRead ? episode.cachedRead / episode.contextRead : null,
      baselinePerRequest: baseline,
      // Estimate, not a counterfactual: the same requests at the session's
      // non-frontier rate. Quality is not compared.
      extraCost: baseline === null ? null : episode.cost - baseline * episode.requests,
    }));
}

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function percentile(values, p) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/**
 * Calibration from the router's own decisions.
 *
 * The two signals that need no quality judge, because the user supplies them by
 * hand:
 *
 *   missed      a held decision, then a manual switch to a frontier model —
 *               the rating was too low for what the task turned out to need
 *   needless    an escalation, then a manual switch away — the rating was too
 *               high, or the switch was not worth its cost
 *
 * Both look forward a bounded number of turns, and both ignore a model change
 * the router itself made (matched within `linkMs` of a decision of the
 * corresponding outcome).
 */
export function decisionStats(session, { patterns, window = 3, linkMs = 5000 } = {}) {
  const decisions = (session?.entries ?? [])
    .filter((entry) => entry.customType === "router-decision" && entry.data)
    .map((entry) => ({ ...entry.data, at: entry.at }));
  const changes = (session?.modelChanges ?? []).filter((change) => change.at);

  const routerChanges = new Set();
  for (const change of changes) {
    const key = `${change.provider}/${change.model}`;
    const isRouterStep = decisions.some(
      (decision) =>
        Math.abs((decision.at ?? 0) - change.at) <= linkMs &&
        (decision.outcome === "escalated" || decision.outcome === "stepped-down") &&
        (decision.to === null || decision.to === key),
    );
    if (isRouterStep) routerChanges.add(change.at);
  }

  const missed = [];
  const needless = [];
  for (const decision of decisions) {
    if (!decision.at) continue;
    const soon = changes.filter(
      (change) => change.at > decision.at && change.at - decision.at <= window * 60_000,
    );
    for (const change of soon) {
      if (routerChanges.has(change.at)) continue;
      const key = `${change.provider}/${change.model}`;
      if (decision.outcome === "held" && isFrontierModel(key, patterns)) {
        missed.push({
          at: decision.at,
          rating: decision.difficulty,
          to: key,
          threshold: decision.threshold,
        });
      }
      if (decision.outcome === "escalated" && !isFrontierModel(key, patterns)) {
        needless.push({ at: decision.at, rating: decision.difficulty, to: key });
      }
    }
  }

  const outcomes = {};
  const ratings = [];
  const latencies = [];
  for (const decision of decisions) {
    outcomes[decision.outcome] = (outcomes[decision.outcome] ?? 0) + 1;
    if (Number.isFinite(decision.difficulty)) ratings.push(decision.difficulty);
    if (Number.isFinite(decision.latencyMs)) latencies.push(decision.latencyMs);
  }

  return {
    decisions: decisions.length,
    outcomes,
    ratings,
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    missed,
    needless,
  };
}

/**
 * Rating buckets and what followed, for tuning the threshold from live use
 * rather than from the enriched historical sample.
 */
export function ratingBuckets(sessions, { patterns, window = 3 } = {}) {
  const buckets = [
    { label: "0–0.9", test: (r) => r < 1 },
    { label: "1.0–1.4", test: (r) => r >= 1 && r < 1.5 },
    { label: "1.5–1.9", test: (r) => r >= 1.5 && r < 2 },
    { label: "2.0+", test: (r) => r >= 2 },
  ].map((bucket) => ({ ...bucket, escalated: 0, held: 0, missed: 0, needless: 0 }));

  for (const session of sessions) {
    const stats = decisionStats(session, { patterns, window });
    const decisions = (session.entries ?? [])
      .filter((entry) => entry.customType === "router-decision" && entry.data)
      .map((entry) => ({ ...entry.data, at: entry.at }));

    for (const decision of decisions) {
      if (!Number.isFinite(decision.difficulty)) continue;
      const bucket = buckets.find((candidate) => candidate.test(decision.difficulty));
      if (!bucket) continue;
      if (decision.outcome === "escalated") bucket.escalated++;
      if (decision.outcome === "held") bucket.held++;
      for (const miss of stats.missed) {
        if (miss.at === decision.at) bucket.missed++;
      }
      for (const item of stats.needless) {
        if (item.at === decision.at) bucket.needless++;
      }
    }
  }
  return buckets;
}
