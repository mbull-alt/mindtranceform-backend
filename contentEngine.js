/**
 * contentEngine.js — Automated content & outreach generation for Mind Tranceform
 *
 * Exports:
 *   runDailyContentGeneration()  — TikTok, Twitter, Reddit post, email subject lines
 *   runDailyOutreach()           — Reddit reply drafts + Twitter reply drafts
 *   runWeeklyContentGeneration() — SEO blog post
 */

"use strict";

const axios  = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const APP_URL = process.env.APP_URL || "https://app.mindtranceformapp.com";

// ─── OPENAI HELPER ────────────────────────────────────────────────────────────
async function openai(prompt, maxTokens = 700) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.85,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.choices[0]?.message?.content?.trim() || "";
}

// ─── SAVE TO SUPABASE ────────────────────────────────────────────────────────
async function saveContent(items) {
  if (!items.length) {
    console.log("[content] saveContent: no items to save");
    return;
  }
  const now = new Date().toISOString();
  const stamped = items.map(item => ({ ...item, generated_at: now }));
  console.log(`[content] saveContent: inserting ${stamped.length} items into content_calendar`);
  console.log("[content] SUPABASE_URL set:", !!process.env.SUPABASE_URL);
  console.log("[content] SERVICE_ROLE_KEY set:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.from("content_calendar").insert(stamped).select("id");
  if (error) {
    console.error("[content] Supabase insert error:", error.message, "code:", error.code, "details:", error.details);
    throw new Error(`Supabase insert failed: ${error.message}`);
  }
  console.log(`[content] saveContent: inserted ${(data||[]).length} rows successfully`);
}

function tomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ─── TIKTOK / REELS SCRIPTS ───────────────────────────────────────────────────
async function generateTikTokScripts() {
  const angles = [
    { topic: "sleep",         audience: "people who lie awake at night, mind racing, unable to switch off" },
    { topic: "anxiety",       audience: "people who carry low-level anxiety all day and can't seem to relax" },
    { topic: "manifestation", audience: "people who want to reprogram their subconscious mind for success and abundance" },
  ];

  const results = [];
  for (const { topic, audience } of angles) {
    try {
      const content = await openai(
        `You are a viral TikTok/Reels scriptwriter for Mind Tranceform — a personalized AI meditation and hypnosis app (${APP_URL}).

Target audience: ${audience}

Write a tight 30-second script. Use this exact structure:
[HOOK] (0-3s) — Scroll-stopping opener. Bold claim or relatable statement.
[PROBLEM] (3-12s) — Deepen the pain. Make them feel seen.
[SOLUTION] (12-22s) — Reveal: Mind Tranceform generates a session using your NAME and specific GOAL. AI writes it. AI voices it. Completely personal.
[CTA] (22-30s) — "Search Mind Tranceform. First session is free."

Rules: spoken delivery only, no hashtags, no stage directions, under 120 words total.`,
        350
      );
      results.push({ type: "tiktok", content, topic, status: "draft", scheduled_for: tomorrowAt(9) });
    } catch (err) {
      console.error(`[content] TikTok/${topic}:`, err.message);
    }
  }
  return results;
}

// ─── TWITTER / X POSTS ────────────────────────────────────────────────────────
async function generateTwitterPosts() {
  const prompts = [
    { topic: "tip",         p: "Write one Twitter/X post (under 280 chars) sharing a single genuinely useful science-backed tip about falling asleep faster. No app mention. End with a question to invite replies." },
    { topic: "story",       p: "Write one Twitter/X post (under 280 chars) in a personal, vulnerable voice about anxiety and a turning point. Mention that personalized meditation helped — not salesy, just honest. Mention @MindTranceform once naturally." },
    { topic: "feature",     p: `Write one Twitter/X post (under 280 chars) highlighting this: "Mind Tranceform writes your meditation script using YOUR name and YOUR exact goal — then voices it with AI." Frame it as a discovery people didn't know existed. Include ${APP_URL}` },
    { topic: "testimonial", p: "Write one Twitter/X post (under 280 chars) as if a real user is sharing a result — better sleep, less anxiety, or more confidence. First person. Authentic. Mentions @MindTranceform." },
    { topic: "question",    p: "Write one thought-provoking Twitter/X question (under 280 chars) about sleep, anxiety, or manifestation that people will want to answer. No app mention — just pure engagement." },
  ];

  const results = [];
  for (const { topic, p } of prompts) {
    try {
      const content = await openai(p, 120);
      results.push({ type: "twitter", content, topic, status: "draft", scheduled_for: tomorrowAt(10) });
    } catch (err) {
      console.error(`[content] Twitter/${topic}:`, err.message);
    }
  }
  return results;
}

// ─── REDDIT POST ─────────────────────────────────────────────────────────────
async function generateRedditPost() {
  const options = [
    { subreddit: "r/sleep",           topic: "sleep",         angle: "a practical deep-dive into why generic sleep advice fails and what personalized audio therapy actually changes" },
    { subreddit: "r/Anxiety",         topic: "anxiety",       angle: "why understanding your own specific anxiety triggers matters more than generic relaxation techniques" },
    { subreddit: "r/meditation",      topic: "meditation",    angle: "why most people quit meditation within 2 weeks and what finally makes it stick — personalization" },
    { subreddit: "r/selfimprovement", topic: "manifestation", angle: "the neuroscience of why generic affirmations don't work and what personalized hypnotic suggestion actually changes in the brain" },
  ];

  const pick = options[new Date().getDay() % options.length];

  try {
    const content = await openai(
      `Write a genuine Reddit post for ${pick.subreddit} about: ${pick.angle}.

Rules:
- Authentic Reddit voice — helpful first, never sounds like marketing
- 350-500 words of real value before any mention of an app
- Near the end, mention Mind Tranceform (${APP_URL}) naturally, as something you personally use or discovered
- First line: "Title: <your title>"
- No hashtags, no excessive formatting

Write the full post now.`,
      650
    );
    return [{ type: "reddit", content, topic: pick.topic, status: "draft", scheduled_for: tomorrowAt(11), metadata: { subreddit: pick.subreddit } }];
  } catch (err) {
    console.error("[content] Reddit post:", err.message);
    return [];
  }
}

// ─── EMAIL SUBJECT LINES ─────────────────────────────────────────────────────
async function generateEmailSubjectLines() {
  try {
    const content = await openai(
      `Generate 10 email subject lines for Mind Tranceform — a personalized AI meditation and hypnosis app.

These are for re-engagement emails to users who haven't yet subscribed.

Use a mix of these angles:
- Curiosity gap
- Personalization ("[name]" as a placeholder)
- Specific benefit (numbers help: "Sleep 40 mins faster")
- Question format
- FOMO / urgency
- Social proof

Format: numbered list, one per line. No explanations. No quotes.`,
      350
    );
    return [{ type: "email", content, topic: "re-engagement", status: "draft", scheduled_for: tomorrowAt(8) }];
  } catch (err) {
    console.error("[content] Email subjects:", err.message);
    return [];
  }
}

// ─── REDDIT OUTREACH (DRAFT ONLY — never auto-posts) ─────────────────────────
async function searchRedditForHelp() {
  const clientId     = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.log("[reddit] credentials not set — skipping outreach");
    return [];
  }

  try {
    const tokenRes = await axios.post(
      "https://www.reddit.com/api/v1/access_token",
      "grant_type=client_credentials",
      {
        auth: { username: clientId, password: clientSecret },
        headers: { "User-Agent": "MindTranceformBot/1.0", "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    const token = tokenRes.data.access_token;
    if (!token) return [];

    const targets = [
      { subreddit: "sleep",           query: "cant sleep help anxiety" },
      { subreddit: "Anxiety",         query: "help anxiety relief nothing works" },
      { subreddit: "meditation",      query: "how to start meditation beginner" },
      { subreddit: "selfimprovement", query: "meditation anxiety sleep improvement" },
    ];

    const results = [];
    for (const { subreddit, query } of targets) {
      try {
        const res = await axios.get(
          `https://oauth.reddit.com/r/${subreddit}/search`,
          {
            params: { q: query, sort: "new", limit: 3, restrict_sr: true, t: "day" },
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "MindTranceformBot/1.0" },
          }
        );

        for (const { data: post } of (res.data?.data?.children || [])) {
          if (!post.selftext || post.selftext.length < 80) continue;
          try {
            const reply = await openai(
              `You're a real person who found relief through personalized meditation.

Reddit post in r/${subreddit}:
Title: ${post.title}
Post: ${post.selftext.slice(0, 600)}

Write a genuine, empathetic reply (150-200 words) that:
1. Validates their experience without being patronising
2. Shares one specific, actionable tip relevant to their situation
3. Mentions naturally that personalized audio meditation helped you — reference Mind Tranceform (${APP_URL}) once, casually, not like an ad
4. Ends with an open question

Human voice only — no bot-speak, no marketing language.`,
              300
            );
            results.push({
              type: "reddit_reply",
              content: reply,
              topic: subreddit,
              status: "draft",
              metadata: { post_id: post.id, post_title: post.title, post_url: `https://reddit.com${post.permalink}`, subreddit },
            });
          } catch {}
        }
      } catch (err) {
        console.error(`[reddit] r/${subreddit}:`, err.message);
      }
    }
    return results;
  } catch (err) {
    console.error("[reddit] auth:", err.message);
    return [];
  }
}

// ─── TWITTER ENGAGEMENT FINDER (DRAFT ONLY) ──────────────────────────────────
async function searchTwitterForEngagement() {
  const bearer = process.env.TWITTER_BEARER_TOKEN;
  if (!bearer) {
    console.log("[twitter] bearer token not set — skipping engagement search");
    return [];
  }

  const queries = [
    "insomnia can't sleep -is:retweet lang:en -is:reply",
    "anxiety overwhelm help -is:retweet lang:en -is:reply",
    "manifestation abundance mindset -is:retweet lang:en -is:reply",
  ];

  const results = [];
  for (const query of queries) {
    try {
      const res = await axios.get(
        "https://api.twitter.com/2/tweets/search/recent",
        {
          params: { query, max_results: 5, "tweet.fields": "text,author_id" },
          headers: { Authorization: `Bearer ${bearer}` },
        }
      );

      for (const tweet of (res.data?.data || []).slice(0, 2)) {
        try {
          const reply = await openai(
            `You're a genuine person who uses Mind Tranceform.

Someone tweeted: "${tweet.text}"

Write a helpful, empathetic Twitter reply (under 240 chars) that:
- Acknowledges what they shared
- Offers one tiny helpful perspective or tip
- Mentions Mind Tranceform naturally only if it genuinely fits
- Sounds completely human — not a brand account

Reply text only.`,
            120
          );
          results.push({
            type: "twitter_reply",
            content: reply,
            topic: "engagement",
            status: "draft",
            metadata: { tweet_id: tweet.id, tweet_text: tweet.text },
          });
        } catch {}
      }
    } catch (err) {
      console.error("[twitter] search:", err.message);
    }
  }
  return results;
}

// ─── BLOG POST GENERATION ─────────────────────────────────────────────────────
async function generateBlogPost() {
  const topics = [
    { topic: "sleep",        hint: "Why Personalized Sleep Meditation Works Better Than Generic Audio Tracks" },
    { topic: "anxiety",      hint: "The Science of Personalized Hypnosis for Anxiety Relief" },
    { topic: "meditation",   hint: "Why Most People Quit Meditation (And What Actually Makes It Stick)" },
    { topic: "manifestation",hint: "Rewiring Your Subconscious: The Truth About Manifestation and Personalized Audio" },
    { topic: "hypnosis",     hint: "Hypnosis Is Not What You Think: A Modern Evidence-Based Guide" },
    { topic: "wellness",     hint: "Why One-Size-Fits-All Wellness Doesn't Work — And What Does" },
  ];

  const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const { topic, hint } = topics[week % topics.length];

  try {
    const raw = await openai(
      `Write an SEO-optimised blog post for Mind Tranceform (${APP_URL}), a personalized AI meditation and hypnosis app.

Title to write around: "${hint}"

Requirements:
- 900-1100 words
- Conversational but authoritative
- Weave in these keywords naturally: personalized meditation, sleep improvement, anxiety relief, AI meditation, hypnosis, Mind Tranceform
- Structure: compelling intro → 3-4 H2 sections with real substance → conclusion with soft CTA to try the free session
- Include one cited statistic or study per section (paraphrase common knowledge is fine)
- Last line: "META: <150-word SEO meta description>"
- Format headers as "## Section Title"
- Start with "# <Your Title>"

Write the full post.`,
      1800
    );

    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const title   = titleMatch ? titleMatch[1].trim() : hint;
    const slug    = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const metaMatch = raw.match(/META:\s*([\s\S]+)$/i);
    const excerpt = metaMatch ? metaMatch[1].trim().slice(0, 300) : raw.slice(0, 300);
    const content = raw.replace(/META:[\s\S]*$/i, "").trim();

    const { error } = await supabase.from("blog_posts").insert({
      title, slug, content, excerpt, topic, status: "draft",
    });

    if (error) {
      // Handle duplicate slug by appending timestamp
      if (error.code === "23505") {
        const { error: e2 } = await supabase.from("blog_posts").insert({
          title, slug: `${slug}-${Date.now()}`, content, excerpt, topic, status: "draft",
        });
        if (e2) console.error("[blog] insert error:", e2.message);
      } else {
        console.error("[blog] insert error:", error.message);
      }
    }

    console.log(`[blog] generated: "${title}"`);
    return { title, slug };
  } catch (err) {
    console.error("[blog] generation failed:", err.message);
    return null;
  }
}

// ─── EXPORTED RUNNERS ────────────────────────────────────────────────────────

async function runDailyContentGeneration() {
  console.log("[content] Daily generation starting...");
  console.log("[content] OPENAI_API_KEY set:", !!process.env.OPENAI_API_KEY);
  console.log("[content] SUPABASE_URL set:", !!process.env.SUPABASE_URL);
  console.log("[content] SUPABASE_SERVICE_ROLE_KEY set:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log("[content] Generating TikTok scripts...");
  const tiktok = await generateTikTokScripts();
  console.log(`[content] TikTok: ${tiktok.length} items`);

  console.log("[content] Generating Twitter posts...");
  const twitter = await generateTwitterPosts();
  console.log(`[content] Twitter: ${twitter.length} items`);

  console.log("[content] Generating Reddit post...");
  const reddit = await generateRedditPost();
  console.log(`[content] Reddit: ${reddit.length} items`);

  console.log("[content] Generating email subject lines...");
  const email = await generateEmailSubjectLines();
  console.log(`[content] Email: ${email.length} items`);

  const all = [...tiktok, ...twitter, ...reddit, ...email];
  console.log(`[content] Total items to save: ${all.length}`);

  await saveContent(all);

  const summary = { tiktok: tiktok.length, twitter: twitter.length, reddit: reddit.length, email: email.length, total: all.length };
  console.log("[content] Daily generation done:", summary);
  return summary;
}

async function runDailyOutreach() {
  console.log("[content] Outreach search starting...");
  const [redditDrafts, twitterDrafts] = await Promise.all([
    searchRedditForHelp(),
    searchTwitterForEngagement(),
  ]);
  const all = [...redditDrafts, ...twitterDrafts];
  await saveContent(all);
  const summary = { reddit_replies: redditDrafts.length, twitter_replies: twitterDrafts.length, total: all.length };
  console.log("[content] Outreach done:", summary);
  return summary;
}

async function runWeeklyContentGeneration() {
  console.log("[content] Weekly generation starting...");
  const blog = await generateBlogPost();
  return { blog_post: blog?.title || null };
}

module.exports = {
  runDailyContentGeneration,
  runDailyOutreach,
  runWeeklyContentGeneration,
  generateBlogPost,
};
