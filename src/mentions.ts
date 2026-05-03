// Resolve Slack mention tokens (<@U…>, <#C…>, <!subteam^…>) into human-readable
// names so Claude actually sees who/what was mentioned.

const userCache = new Map<string, string>();
const channelCache = new Map<string, string>();
const subteamCache = new Map<string, string>();

const CACHE_TTL_MS = 60 * 60 * 1000;
const userCacheAt = new Map<string, number>();

async function resolveUser(client: any, userId: string): Promise<string> {
  const now = Date.now();
  const cachedAt = userCacheAt.get(userId);
  if (cachedAt && now - cachedAt < CACHE_TTL_MS) {
    const cached = userCache.get(userId);
    if (cached) return cached;
  }
  try {
    const res = await client.users.info({ user: userId });
    const profile = res.user?.profile || {};
    const name =
      profile.display_name_normalized ||
      profile.display_name ||
      profile.real_name_normalized ||
      profile.real_name ||
      res.user?.name ||
      userId;
    userCache.set(userId, name);
    userCacheAt.set(userId, now);
    return name;
  } catch (e: any) {
    console.error(`[mentions] users.info ${userId} failed: ${e.data?.error || e.message}`);
    return userId;
  }
}

async function resolveChannel(client: any, channelId: string): Promise<string> {
  const cached = channelCache.get(channelId);
  if (cached) return cached;
  try {
    const res = await client.conversations.info({ channel: channelId });
    const name = res.channel?.name || channelId;
    channelCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

async function resolveSubteam(client: any, subteamId: string, fallback?: string): Promise<string> {
  if (fallback) {
    subteamCache.set(subteamId, fallback);
    return fallback;
  }
  const cached = subteamCache.get(subteamId);
  if (cached) return cached;
  try {
    const res = await client.usergroups.list({ include_users: false });
    const groups = (res.usergroups || []) as any[];
    for (const g of groups) {
      if (g.id === subteamId) {
        const name = g.handle ? `@${g.handle}` : g.name || subteamId;
        subteamCache.set(subteamId, name);
        return name;
      }
    }
  } catch {}
  return subteamId;
}

export async function resolveMentions(
  client: any,
  text: string,
  botUserId?: string,
): Promise<string> {
  if (!text) return text;

  // Bot's own mention → strip entirely (it's just addressing us)
  if (botUserId) {
    text = text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), "").trim();
  }

  // <@U123|name> → keep name. <@U123> → look up.
  const userMatches = Array.from(text.matchAll(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g));
  for (const m of userMatches) {
    const [token, uid, embeddedName] = m;
    let display: string;
    if (embeddedName) {
      display = embeddedName;
      userCache.set(uid, embeddedName);
      userCacheAt.set(uid, Date.now());
    } else {
      display = await resolveUser(client, uid);
    }
    text = text.replaceAll(token, `@${display}`);
  }

  // <#C123|name> → #name. <#C123> → look up.
  const channelMatches = Array.from(text.matchAll(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g));
  for (const m of channelMatches) {
    const [token, cid, embedded] = m;
    const name = embedded || (await resolveChannel(client, cid));
    text = text.replaceAll(token, `#${name}`);
  }

  // <!subteam^S123|@handle> → @handle. <!subteam^S123> → look up.
  const subteamMatches = Array.from(text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|([^>]+))?>/g));
  for (const m of subteamMatches) {
    const [token, sid, embedded] = m;
    const name = await resolveSubteam(client, sid, embedded);
    text = text.replaceAll(token, name);
  }

  // Broadcast tokens
  text = text.replace(/<!here>/g, "@here");
  text = text.replace(/<!channel>/g, "@channel");
  text = text.replace(/<!everyone>/g, "@everyone");

  // Generic <!subteam^…> already handled. Other <!…|label> → label.
  text = text.replace(/<![^>]+\|([^>]+)>/g, "$1");

  return text.trim();
}
