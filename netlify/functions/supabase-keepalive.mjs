// Second, INDEPENDENT Supabase keep-alive, running on Netlify's scheduler.
//
// Why two of them: free-tier Supabase pauses projects with "low activity over
// a 7-day period" - the documented bar is "a few user requests to the database
// each day over the previous week"
// (https://supabase.com/docs/guides/platform/free-project-pausing).
// The GitHub Actions heartbeat (.github/workflows/supabase-heartbeat.yml)
// covers that, but it has a failure mode it cannot fix from the inside: GitHub
// automatically disables scheduled workflows in a PUBLIC repo after 60 days
// with no repository activity. This project goes weeks between pushes, so that
// is a real, silent, guaranteed-eventually outage.
//
// This function is on a different provider with a different scheduler, so no
// single disable/outage takes the keep-alive down. It hits the same
// eu5_heartbeat_ping() RPC (supabase/migrations/20260827000000_eu5_heartbeat.sql).
//
// Note: Netlify blocks HTTP invocation of scheduled functions in production -
// verify it with `netlify functions:invoke supabase-keepalive` locally, or in
// the function log at https://app.netlify.com/projects/llamabeg/logs/functions

export default async () => {
  const baseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  // Both are set on the Netlify project with scope "All", so they reach the
  // function at runtime as well as the build. If that ever changes, say so
  // loudly - a keep-alive that quietly does nothing is the whole problem.
  if (!baseUrl || !anonKey) {
    console.error(
      "Supabase keep-alive SKIPPED: SUPABASE_URL/SUPABASE_ANON_KEY are not visible to this function. " +
        "Check the env var scopes include Functions in the Netlify project settings."
    );
    return new Response("missing SUPABASE_URL/SUPABASE_ANON_KEY", { status: 500 });
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/rest/v1/rpc/eu5_heartbeat_ping`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.text()).slice(0, 300);

    if (!res.ok) {
      console.error(`Supabase keep-alive FAILED: HTTP ${res.status} - ${body}`);
      return new Response(`HTTP ${res.status}: ${body}`, { status: 502 });
    }

    console.log(`Supabase keep-alive OK - wrote pinged_at=${body}`);
    return new Response(body, { status: 200 });
  } catch (err) {
    // A paused project stops resolving in DNS, so this is where a pause shows up.
    console.error(
      `Supabase keep-alive FAILED (project may be PAUSED - restore at ` +
        `https://supabase.com/dashboard/project/wkylbxozlppqovlwjxsy): ${err?.message || err}`
    );
    return new Response(String(err?.message || err), { status: 502 });
  }
};

export const config = { schedule: "@hourly" };
