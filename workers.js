// ===== 画面左下に表示するバージョン表記 =====
// デプロイ時にここを更新してください(例: "1.01", "1.10", "2.00")
const APP_DISPLAY_VERSION = "5.7";

export default {
  // ===== 定期バックアップ (Cron Trigger) =====
  // wrangler.toml に以下を追加してください:
  //   [triggers]
  //   crons = ["0 18 * * *"]   # 例: 毎日 03:00 JST (UTC 18:00) に実行
  // また R2 バケットのバインディングを追加してください:
  //   [[r2_buckets]]
  //   binding = "BACKUP_BUCKET"
  //   bucket_name = "your-bucket-name"
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerBackup(env, ctx, "cron"));
  },

  async fetch(req, env, ctx) {
    // ===== 手動バックアップ用エンドポイント =====
    // 許可されているのは Discord アカウント (ユーザーID: 1047797479665578014) でログイン中の本人のみ。
    // /auth/login で先にDiscordログインしてから、ブラウザで /api/admin/backup?key=<BACKUP_ADMIN_KEY> を開いてください。
    // (key はこれまで通りの追加防御。Discord本人確認に加えて両方が必要です)
    {
      const _url = new URL(req.url);
      if (_url.pathname === "/api/admin/backup") {
        const ADMIN_DISCORD_ID = "1047797479665578014";
        const session = await getSession(req, env);
        if (!session || session.id !== ADMIN_DISCORD_ID) {
          return new Response("Unauthorized: Discordログインが必要です(許可されたアカウントのみ)。", { status: 403 });
        }
        const key = _url.searchParams.get("key");
        if (!env.BACKUP_ADMIN_KEY || key !== env.BACKUP_ADMIN_KEY) {
          return new Response("Unauthorized: key が正しくありません。", { status: 403 });
        }
        try {
          const force = _url.searchParams.get("force") === "1";
          const result = force ? await runBackup(env) : await triggerBackup(env, ctx, "manual");
          return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }
    }

    // ===== コード更新検知バックアップ =====
    // CODE_VERSION (このファイル下部で定義) をデプロイごとに変更すると、
    // 次回アクセス時に1回だけ自動でバックアップが走ります。
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(checkCodeVersionAndBackup(env, ctx));
    }

    const url = new URL(req.url);
    const path = url.pathname;

    if (!env.CALENDAR_KV || !env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
      return new Response("⚠️ 設定未完了: KVバインディングまたはDiscord設定が必要です。", {status: 500, headers:{"Content-Type":"text/html; charset=utf-8"}});
    }

    function htmlEscape(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function normalizeId(id) {
        if (!id) return "";
        return id
            .trim()
            .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
            .replace(/[−–—]/g, '-')
            .replace(/[^a-zA-Z0-9-_]/g, '');
    }

    if (path === "/auth/login") {
      const redirectUri = `${url.origin}/auth/callback`;
      const redirectTarget = url.searchParams.get("state") ? decodeURIComponent(url.searchParams.get("state")) : "/create";
      const state = encodeURIComponent(redirectTarget);
      const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${state}`;
      return Response.redirect(oauthUrl);
    }

    if (path === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Auth Code Missing", { status: 400 });
      const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code: code,
          redirect_uri: `${url.origin}/auth/callback`,
        }),
      });
      const tokenData = await tokenResp.json();
      if (tokenData.error) return new Response("Discord Auth Failed", { status: 400 });
      const userResp = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userResp.json();
      const avatarUrl = userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(userData.id) >> 22n) % 6n}.png`;
      const sessionData = await createSessionCookie(env, { id: userData.id, name: userData.username, avatar: avatarUrl, exp: Date.now() + 86400000 });
      const redirectTarget = url.searchParams.get("state") ? decodeURIComponent(url.searchParams.get("state")) : "/create";
      return new Response(null, {
        status: 302,
        headers: {
          "Location": redirectTarget,
          "Set-Cookie": `session=${sessionData}; Path=/; HttpOnly; Secure; SameSite=Lax`
        }
      });
    }

    if (path === "/create") {
      const session = await getSession(req, env);
      if (!session) {
        return new Response(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ログイン必要</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:24px;padding:40px 32px;width:100%;max-width:360px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.15)}.icon{font-size:48px;margin-bottom:16px}h2{font-size:1.4rem;color:#1a1a2e;margin-bottom:8px}p{color:#666;margin-bottom:28px;font-size:0.9rem}.btn{display:inline-flex;align-items:center;gap:10px;background:#5865F2;color:white;padding:14px 28px;text-decoration:none;border-radius:14px;font-weight:700;font-size:1rem;transition:transform 0.2s,box-shadow 0.2s}.btn:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(88,101,242,0.4)}</style></head><body><div class="card"><div class="icon">🔐</div><h2>ログインが必要です</h2><p>カレンダー作成にはDiscordアカウントが必要です</p><a href="/auth/login" class="btn">Discordでログイン</a></div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST") {
        const formData = await req.formData();
        const rawId = formData.get("custom_id");
        const customId = normalizeId(rawId);
        const pass = formData.get("password").trim();
        const title = formData.get("title") || "名称未設定";
        if (!customId) return new Response("IDが無効です", {status:400});
        const existing = await env.CALENDAR_KV.get(`META_${customId}`);
        if (existing) {
            return new Response(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>エラー</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:white;border-radius:24px;padding:40px 32px;width:100%;max-width:360px;text-align:center}.icon{font-size:48px;margin-bottom:16px}h1{font-size:1.3rem;color:#e74c3c;margin-bottom:12px}p{color:#666;margin-bottom:24px}a{color:#007aff;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="icon">⚠️</div><h1>IDが使用中です</h1><p>「${customId}」は既に使用されています。<br>別のIDをお試しください。</p><a href="/create">← 戻る</a></div></body></html>`, {headers:{"Content-Type":"text/html; charset=utf-8"}});
        }
        await env.CALENDAR_KV.put(`META_${customId}`, JSON.stringify({
            password: pass, title: title, owner: session.name, ownerId: session.id, created: Date.now(), editMode: "all"
        }));
        return Response.redirect(`${url.origin}/?id=${customId}&password=${pass}`);
      }
      return new Response(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="https://i.imgur.com/nVfK5HE.png"><title>カレンダー作成</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:24px;padding:40px 32px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,0.15)}.logo{text-align:center;font-size:40px;margin-bottom:8px}h2{text-align:center;font-size:1.4rem;color:#1a1a2e;margin-bottom:4px}.welcome{text-align:center;color:#888;font-size:0.9rem;margin-bottom:28px}label{display:block;font-size:0.85rem;font-weight:600;color:#555;margin-bottom:6px}input{width:100%;padding:14px 16px;border:2px solid #eee;border-radius:12px;font-size:1rem;transition:border-color 0.2s;outline:none;margin-bottom:18px}input:focus{border-color:#667eea}.hint{font-size:0.78rem;color:#aaa;margin-top:-14px;margin-bottom:18px}button{width:100%;padding:16px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:14px;font-size:1rem;font-weight:700;cursor:pointer;transition:transform 0.2s,box-shadow 0.2s}button:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(102,126,234,0.4)}</style></head><body><div class="card"><div class="logo">📅</div><h2>新規カレンダー作成</h2><div class="welcome">ようこそ、${session.name}さん</div><form method="POST"><label>希望ID</label><input type="text" name="custom_id" placeholder="例: 2-1" required><div class="hint">クラス番号など短いIDを推奨</div><label>カレンダー名</label><input type="text" name="title" placeholder="例: 2年1組" required><label>パスワード</label><input type="text" name="password" placeholder="閲覧用パスワード" required><button type="submit">作成する →</button></form></div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (path === "/auth/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": req.headers.get("Referer") || "/",
          "Set-Cookie": `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
        }
      });
    }

    if (path === "/api/settings") {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status:403});
      if (req.method === "POST") {
        const session = await getSession(req, env);
        if (!session || session.id !== meta.ownerId) return new Response("Forbidden", {status:403});
        const body = await req.json();
        if (body.editMode === "all" || body.editMode === "discord") {
          meta.editMode = body.editMode;
          await env.CALENDAR_KV.put(`META_${id}`, JSON.stringify(meta));
          return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
        }
        return new Response("Invalid", {status:400});
      }
      return new Response(JSON.stringify({editMode: meta.editMode || "all", owner: meta.owner}), {headers:{"Content-Type":"application/json"}});
    }

    if (path === "/api/sync/version") {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status:403});
      const ver = await env.CALENDAR_KV.get(`DATA_VER_${id}`);
      return new Response(JSON.stringify({ ver: ver || "0" }), {headers:{"Content-Type":"application/json"}});
    }

    if (path === "/api/sync") {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status:403});
      if (req.method === "GET") {
        const data = await env.CALENDAR_KV.get(`DATA_${id}`);
        const ver = await env.CALENDAR_KV.get(`DATA_VER_${id}`);
        return new Response(JSON.stringify({ data: data ? JSON.parse(data) : {}, ver: ver || "0" }), {headers:{"Content-Type":"application/json"}});
      }
      if (req.method === "POST") {
        const editMode = meta.editMode || "all";
        if (editMode === "discord") {
          const session = await getSession(req, env);
          if (!session) return new Response("Login required", {status:401});
        }
        const body = await req.text();
        const ver = String(Date.now());
        await env.CALENDAR_KV.put(`DATA_VER_${id}`, ver);
        await env.CALENDAR_KV.put(`DATA_${id}`, body);
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(triggerBackup(env, ctx, "calendar-update"));
        }
        return new Response("Saved");
      }
    }

    if (path === "/api/scan") {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status: 403});
      if (req.method !== "POST") return new Response("Method Not Allowed", {status: 405});
      if (!env.AI) return new Response(JSON.stringify({error: "AI binding not configured"}), {status: 500, headers: {"Content-Type": "application/json"}});

      try {
        const body = await req.json();
        const b64 = body.image.replace(/^data:image\/\w+;base64,/, "");
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const prompt = `この画像は学校の時間割表です。1限から6限の科目名を読み取り、必ずJSON形式のみで答えてください。説明不要。形式: {"1":"科目","2":"科目","3":"科目","4":"科目","5":"科目","6":"科目"} 科目が不明な場合は""にしてください。手書きの略字（例:「国」=国語、「数」=数学、「理」=理科、「社」=社会、「英」=英語、「体」=体育、「音」=音楽、「美」=美術、「技」=技術、「家」=家庭科、「道」=道徳、「総」=総合）は、わかる範囲で正式名称に展開してください。各段ごとに異なる文字を必ず個別に読み取り、同じ科目名を安易に繰り返さないでください。`;

        const result = await env.AI.run("@cf/mistralai/mistral-small-3.1-24b-instruct", {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
              ]
            }
          ],
          max_tokens: 512,
        });

        const text = (result.response || result.description || "").trim();
        const jsonMatch = text.match(/\{[^}]+\}/);
        if (!jsonMatch) {
          return new Response(JSON.stringify({error: "parse_failed", raw: text}), {status: 422, headers: {"Content-Type": "application/json"}});
        }
        const parsed = JSON.parse(jsonMatch[0]);
        return new Response(JSON.stringify({ok: true, periods: parsed}), {headers: {"Content-Type": "application/json"}});
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {status: 500, headers: {"Content-Type": "application/json"}});
      }
    }

    if (path === "/api/images") {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status:403});

      const imagesKey = `IMAGES_${id}`;

      if (req.method === "GET") {
        const data = await env.CALENDAR_KV.get(imagesKey);
        return new Response(data || "[]", {headers:{"Content-Type":"application/json"}});
      }

      if (req.method === "POST") {
        const editMode = meta.editMode || "all";
        if (editMode === "discord") {
          const session = await getSession(req, env);
          if (!session) return new Response("Login required", {status:401});
        }
        const body = await req.json();
        const existing = JSON.parse(await env.CALENDAR_KV.get(imagesKey) || "[]");
        const newImg = {
          id: Date.now().toString(),
          name: (body.name || "").slice(0, 40),
          dataUrl: body.dataUrl,
          uploadedAt: Date.now()
        };
        if (existing.length >= 50) {
          return new Response(JSON.stringify({ok:false, error:"limit"}), {status:400, headers:{"Content-Type":"application/json"}});
        }
        existing.push(newImg);
        const trimmed = existing.slice(-50);
        await env.CALENDAR_KV.put(imagesKey, JSON.stringify(trimmed));
        return new Response(JSON.stringify({ok:true, id: newImg.id}), {headers:{"Content-Type":"application/json"}});
      }

      if (req.method === "DELETE") {
        const session = await getSession(req, env);
        const imgId = url.searchParams.get("imgId");
        const existing = JSON.parse(await env.CALENDAR_KV.get(imagesKey) || "[]");
        const editMode = meta.editMode || "all";
        const canDelete = (editMode === "all") || (session && session.id === meta.ownerId);
        if (!canDelete) return new Response("Forbidden", {status:403});
        const filtered = existing.filter(img => img.id !== imgId);
        await env.CALENDAR_KV.put(imagesKey, JSON.stringify(filtered));
        return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
      }
    }

    if (path === "/api/chat") {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status:403});

      const chatKey = `CHAT_${id}`;
      const CHAT_LIMIT = 300;

      if (req.method === "GET") {
        const since = parseInt(url.searchParams.get("since") || "0", 10);
        const data = JSON.parse(await env.CALENDAR_KV.get(chatKey) || "[]");
        const filtered = since ? data.filter(m => m.ts > since) : data;
        return new Response(JSON.stringify(filtered), {headers:{"Content-Type":"application/json"}});
      }

      if (req.method === "POST") {
        const editMode = meta.editMode || "all";
        const session = await getSession(req, env);
        if (editMode === "discord" && !session) return new Response("Login required", {status:401});

        const body = await req.json();
        const text = (body.text || "").slice(0, 1000);
        const image = body.image || null;
        if (!text.trim() && !image) return new Response(JSON.stringify({error:"empty"}), {status:400, headers:{"Content-Type":"application/json"}});

        let displayName, displayAvatar, userKey;
        if (session) {
          displayName = session.name;
          displayAvatar = session.avatar;
          userKey = `discord:${session.id}`;
        } else {
          // ゲストはチャットアカウント(名前+パスワード)でのログインが必須
          const guestName = (body.name || "").slice(0, 30);
          const authToken = body.authToken || "";
          const norm = normalizeChatName(guestName);
          if (!norm || !authToken) return new Response(JSON.stringify({error:"auth_required"}), {status:401, headers:{"Content-Type":"application/json"}});
          const account = await env.CALENDAR_KV.get(`CHATUSER_${id}_${norm}`, {type:"json"});
          if (!account || account.authToken !== authToken) {
            return new Response(JSON.stringify({error:"auth_invalid"}), {status:401, headers:{"Content-Type":"application/json"}});
          }
          displayName = account.name;
          displayAvatar = body.avatar || account.avatar || "";
          userKey = `guest:${norm}`;
        }

        const existing = JSON.parse(await env.CALENDAR_KV.get(chatKey) || "[]");
        const newMsg = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          ts: Date.now(),
          userKey,
          name: displayName,
          avatar: displayAvatar,
          text,
          image
        };
        existing.push(newMsg);
        const trimmed = existing.slice(-CHAT_LIMIT);
        await env.CALENDAR_KV.put(chatKey, JSON.stringify(trimmed));
        return new Response(JSON.stringify({ok:true, message:newMsg}), {headers:{"Content-Type":"application/json"}});
      }
      return new Response("Method Not Allowed", {status:405});
    }

    // ===== /api/chat-auth: ゲスト用チャットアカウントの新規登録・ログイン =====
    if (path === "/api/chat-auth") {
      if (req.method !== "POST") return new Response("Method Not Allowed", {status:405});
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!meta || meta.password !== pass) return new Response("Unauthorized", {status:403});

      const body = await req.json();
      const action = body.action; // "register" | "login"
      const rawName = (body.name || "").trim().slice(0, 20);
      const password = (body.password || "").slice(0, 100);
      const norm = normalizeChatName(rawName);

      if (!rawName || !norm) {
        return new Response(JSON.stringify({error:"name_required"}), {status:400, headers:{"Content-Type":"application/json"}});
      }
      if (!password || password.length < 4) {
        return new Response(JSON.stringify({error:"password_too_short"}), {status:400, headers:{"Content-Type":"application/json"}});
      }

      const userKey = `CHATUSER_${id}_${norm}`;

      if (action === "register") {
        const existing = await env.CALENDAR_KV.get(userKey, {type:"json"});
        if (existing) {
          return new Response(JSON.stringify({error:"name_taken"}), {status:409, headers:{"Content-Type":"application/json"}});
        }
        const salt = randomHex(16);
        const passHash = await hashPassword(password, salt);
        const authToken = randomHex(24);
        const account = { name: rawName, avatar: body.avatar || "", salt, passHash, authToken, createdAt: Date.now() };
        await env.CALENDAR_KV.put(userKey, JSON.stringify(account));
        return new Response(JSON.stringify({ok:true, name: rawName, authToken}), {headers:{"Content-Type":"application/json"}});
      }

      if (action === "login") {
        const account = await env.CALENDAR_KV.get(userKey, {type:"json"});
        if (!account) {
          return new Response(JSON.stringify({error:"not_found"}), {status:404, headers:{"Content-Type":"application/json"}});
        }
        const passHash = await hashPassword(password, account.salt);
        if (passHash !== account.passHash) {
          return new Response(JSON.stringify({error:"wrong_password"}), {status:401, headers:{"Content-Type":"application/json"}});
        }
        // ログイン成功時にトークンを再発行(他デバイスのトークンは無効化される)
        const authToken = randomHex(24);
        account.authToken = authToken;
        await env.CALENDAR_KV.put(userKey, JSON.stringify(account));
        return new Response(JSON.stringify({ok:true, name: account.name, avatar: account.avatar || "", authToken}), {headers:{"Content-Type":"application/json"}});
      }

      return new Response(JSON.stringify({error:"invalid_action"}), {status:400, headers:{"Content-Type":"application/json"}});
    }

    // ===== /api/yesterday, /api/today, /api/tomorrow, /api/<weekday>, /api/YYYYMMDD =====
    const dateApiMatch = path.match(/^\/api\/(yesterday|today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{8})\/?$/i);
    if (dateApiMatch) {
      const rawId = url.searchParams.get("id");
      const id = normalizeId(rawId);
      const pass = url.searchParams.get("password") ?? url.searchParams.get("pass");
      const meta = await env.CALENDAR_KV.get(`META_${id}`, {type: "json"});
      if (!id || !meta) {
        return new Response(JSON.stringify({error: "calendar_not_found"}), {status: 404, headers: {"Content-Type": "application/json; charset=utf-8"}});
      }
      if (meta.password !== pass) {
        return new Response(JSON.stringify({error: "unauthorized"}), {status: 403, headers: {"Content-Type": "application/json; charset=utf-8"}});
      }

      // 「今日」は日本時間 (JST) で判定する
      const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const todayY = jstNow.getUTCFullYear();
      const todayM = jstNow.getUTCMonth(); // 0-indexed
      const todayD = jstNow.getUTCDate();
      const todayUTC = new Date(Date.UTC(todayY, todayM, todayD));

      const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const token = dateApiMatch[1].toLowerCase();
      let targetUTC;

      if (token === "today") {
        targetUTC = todayUTC;
      } else if (token === "yesterday") {
        targetUTC = new Date(todayUTC.getTime() - 86400000);
      } else if (token === "tomorrow") {
        targetUTC = new Date(todayUTC.getTime() + 86400000);
      } else if (WEEKDAYS.includes(token)) {
        // 直近のその曜日（今日がその曜日なら今日）
        const targetDow = WEEKDAYS.indexOf(token);
        const todayDow = todayUTC.getUTCDay();
        const diff = (targetDow - todayDow + 7) % 7;
        targetUTC = new Date(todayUTC.getTime() + diff * 86400000);
      } else {
        // YYYYMMDD
        const y = parseInt(token.slice(0, 4), 10);
        const m = parseInt(token.slice(4, 6), 10) - 1;
        const d = parseInt(token.slice(6, 8), 10);
        targetUTC = new Date(Date.UTC(y, m, d));
        if (isNaN(targetUTC.getTime()) || targetUTC.getUTCMonth() !== m || targetUTC.getUTCDate() !== d) {
          return new Response(JSON.stringify({error: "invalid_date"}), {status: 400, headers: {"Content-Type": "application/json; charset=utf-8"}});
        }
      }

      const ty = targetUTC.getUTCFullYear();
      const tm = targetUTC.getUTCMonth() + 1; // 1-indexed
      const td = targetUTC.getUTCDate();
      const key = `${ty}-${tm}-${td}`;
      const dateStr = `${ty}-${String(tm).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
      const weekday = WEEKDAYS[targetUTC.getUTCDay()];
      const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

      const rawData = await env.CALENDAR_KV.get(`DATA_${id}`);
      const allData = rawData ? JSON.parse(rawData) : {};
      const entry = allData[key] || { periods: {}, note: "" };

      const periodsArr = [];
      const PERIODS_COUNT = 6;
      for (let p = 1; p <= PERIODS_COUNT; p++) {
        periodsArr.push({ period: p, subject: (entry.periods && entry.periods[p]) || "" });
      }

      return new Response(JSON.stringify({
        id: id,
        title: meta.title || "",
        date: dateStr,
        weekday: weekday,
        weekday_ja: WEEKDAY_JA[targetUTC.getUTCDay()],
        periods: periodsArr,
        note: entry.note || ""
      }, null, 2), {headers: {"Content-Type": "application/json; charset=utf-8"}});
    }

    const rawId = url.searchParams.get("id");
    const calendarId = normalizeId(rawId);
    const password = url.searchParams.get("password");

    if (!calendarId) {
        return new Response(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <link rel="icon" href="https://i.imgur.com/nVfK5HE.png">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>時間割カレンダー</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;background:linear-gradient(160deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:rgba(255,255,255,0.05);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:28px;padding:44px 36px;width:100%;max-width:380px}
    .logo-wrap{text-align:center;margin-bottom:24px}
    .logo-icon{font-size:52px;display:block;margin-bottom:8px}
    h1{color:white;font-size:1.6rem;font-weight:700;text-align:center;margin-bottom:4px}
    .sub{color:rgba(255,255,255,0.5);text-align:center;font-size:0.85rem;margin-bottom:32px}
    label{display:block;color:rgba(255,255,255,0.7);font-size:0.8rem;font-weight:600;letter-spacing:0.05em;margin-bottom:8px}
    input{width:100%;padding:14px 16px;background:rgba(255,255,255,0.08);border:1.5px solid rgba(255,255,255,0.15);border-radius:14px;color:white;font-size:1rem;outline:none;transition:all 0.2s;margin-bottom:20px}
    input::placeholder{color:rgba(255,255,255,0.3)}
    input:focus{border-color:rgba(102,126,234,0.8);background:rgba(255,255,255,0.12)}
    .btn-open{width:100%;padding:16px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;border-radius:16px;font-size:1rem;font-weight:700;cursor:pointer;transition:all 0.2s;margin-top:4px}
    .btn-open:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(102,126,234,0.4)}
    .divider{display:flex;align-items:center;gap:12px;margin:24px 0}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:rgba(255,255,255,0.1)}
    .divider span{color:rgba(255,255,255,0.3);font-size:0.8rem}
    .btn-discord{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;background:rgba(88,101,242,0.3);border:1.5px solid rgba(88,101,242,0.5);color:white;border-radius:16px;text-decoration:none;font-size:0.95rem;font-weight:600;transition:all 0.2s}
    .btn-discord:hover{background:rgba(88,101,242,0.5);transform:translateY(-2px)}
    .discord-logo{width:22px;height:22px;fill:white}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-wrap">
      <span class="logo-icon">📚</span>
      <h1>時間割</h1>
      <p class="sub">クラスの時間割を管理しよう</p>
    </div>
    <form action="/" method="GET">
      <label>クラスID</label>
      <input type="text" name="id" placeholder="例: 2-1" required autocomplete="off">
      <label>パスワード</label>
      <input type="password" name="password" placeholder="パスワードを入力" required>
      <button class="btn-open" type="submit">開く</button>
    </form>
    <div class="divider"><span>または</span></div>
    <a href="/auth/login" class="btn-discord">
      <svg class="discord-logo" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
      Discordで新規作成
    </a>
  </div>
</body></html>`, { headers: {"Content-Type": "text/html; charset=utf-8"} });
    }

    const metaStr = await env.CALENDAR_KV.get(`META_${calendarId}`);
    if (!metaStr) {
        return new Response(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:white;border-radius:24px;padding:40px 32px;width:100%;max-width:360px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08)}.icon{font-size:52px;margin-bottom:16px}h2{font-size:1.3rem;color:#333;margin-bottom:12px}p{color:#888;margin-bottom:24px;font-size:0.9rem;line-height:1.6}a{color:#667eea;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="icon">😢</div><h2>IDが見つかりません</h2><p>ID「<b>${calendarId}</b>」のカレンダーが存在しません。<br>IDが正しいか確認してください。</p><a href="/">← トップへ戻る</a></div></body></html>`, { status: 404, headers:{"Content-Type":"text/html; charset=utf-8"} });
    }
    const meta = JSON.parse(metaStr);
    if (meta.password !== password) {
         return new Response(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>認証エラー</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:white;border-radius:24px;padding:40px 32px;width:100%;max-width:360px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08)}.icon{font-size:52px;margin-bottom:16px}h2{font-size:1.3rem;color:#e74c3c;margin-bottom:24px}a{color:#667eea;text-decoration:none;font-weight:600}</style></head><body><div class="card"><div class="icon">🔒</div><h2>パスワードが違います</h2><a href="/">← 戻る</a></div></body></html>`, { headers:{"Content-Type":"text/html; charset=utf-8"} });
    }

    const session = await getSession(req, env);
    const isOwner = session && session.id === meta.ownerId;
    const editMode = meta.editMode || "all";
    const canEdit = editMode === "all" || (editMode === "discord" && !!session);
    const DISCORD_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>`;
    return new Response(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <link rel="icon" href="https://i.imgur.com/nVfK5HE.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>${htmlEscape(meta.title)}</title>
  <style>
    :root {
      --primary: #667eea;
      --primary-dark: #5a67d8;
      --bg: #f7f8fc;
      --surface: #ffffff;
      --surface-2: #f7f8fc;
      --text: #1a1a2e;
      --text-sub: #8892a4;
      --border: #eef0f5;
      --today-bg: #eef2ff;
      --today-border: #667eea;
      --header-bg: rgba(255,255,255,0.85);
      --overlay-bg: rgba(0,0,0,0.45);
      --input-focus-bg: #ffffff;
      --chip-sat: 70%;
      --chip-light: 82%;
      --chip-text: #1a1a2e;
      --readonly-text: #856404;
      --radius-card: 16px;
      --radius-sm: 10px;
      --shadow-sm: 0 2px 8px rgba(0,0,0,0.06);
      --shadow-md: 0 8px 30px rgba(0,0,0,0.1);
      --shadow-lg: 0 20px 60px rgba(0,0,0,0.15);
      --safe-bottom: env(safe-area-inset-bottom, 0px);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --primary: #818cf8;
        --primary-dark: #6f7ce8;
        --bg: #1c1d26;
        --surface: #282933;
        --surface-2: #323341;
        --text: #eceef5;
        --text-sub: #9aa0b4;
        --border: #3c3e4d;
        --today-bg: #2d3050;
        --today-border: #818cf8;
        --header-bg: rgba(28,29,38,0.85);
        --overlay-bg: rgba(0,0,0,0.6);
        --input-focus-bg: #3d3f50;
        --chip-sat: 65%;
        --chip-light: 45%;
        --chip-text: #ffffff;
        --readonly-text: #ffd76e;
        --shadow-sm: 0 2px 8px rgba(0,0,0,0.3);
        --shadow-md: 0 8px 30px rgba(0,0,0,0.4);
        --shadow-lg: 0 20px 60px rgba(0,0,0,0.55);
      }
    }
    html[data-theme="light"] {
      --primary: #667eea;
      --primary-dark: #5a67d8;
      --bg: #f7f8fc;
      --surface: #ffffff;
      --surface-2: #f7f8fc;
      --text: #1a1a2e;
      --text-sub: #8892a4;
      --border: #eef0f5;
      --today-bg: #eef2ff;
      --today-border: #667eea;
      --header-bg: rgba(255,255,255,0.85);
      --overlay-bg: rgba(0,0,0,0.45);
      --input-focus-bg: #ffffff;
      --chip-sat: 70%;
      --chip-light: 82%;
      --chip-text: #1a1a2e;
      --readonly-text: #856404;
      --shadow-sm: 0 2px 8px rgba(0,0,0,0.06);
      --shadow-md: 0 8px 30px rgba(0,0,0,0.1);
      --shadow-lg: 0 20px 60px rgba(0,0,0,0.15);
    }
    html[data-theme="dark"] {
      --primary: #818cf8;
      --primary-dark: #6f7ce8;
      --bg: #1c1d26;
      --surface: #282933;
      --surface-2: #323341;
      --text: #eceef5;
      --text-sub: #9aa0b4;
      --border: #3c3e4d;
      --today-bg: #2d3050;
      --today-border: #818cf8;
      --header-bg: rgba(28,29,38,0.85);
      --overlay-bg: rgba(0,0,0,0.6);
      --input-focus-bg: #3d3f50;
      --chip-sat: 65%;
      --chip-light: 45%;
      --chip-text: #ffffff;
      --readonly-text: #ffd76e;
      --shadow-sm: 0 2px 8px rgba(0,0,0,0.3);
      --shadow-md: 0 8px 30px rgba(0,0,0,0.4);
      --shadow-lg: 0 20px 60px rgba(0,0,0,0.55);
    }
    * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    html, body { height:100%; overscroll-behavior:none; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      min-height: -webkit-fill-available;
    }

    /* ===== ANDROID APP DOWNLOAD BANNER ===== */
    .android-app-banner {
      display: none;
      align-items: center;
      gap: 10px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
      padding: 10px 14px;
      padding-top: max(10px, env(safe-area-inset-top));
      position: relative;
      z-index: 60;
    }
    .android-app-banner.show { display: flex; }
    .android-app-banner .aab-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
      line-height: 1;
    }
    .android-app-banner .aab-text {
      flex: 1;
      min-width: 0;
    }
    .android-app-banner .aab-title {
      font-size: 0.82rem;
      font-weight: 700;
      line-height: 1.3;
    }
    .android-app-banner .aab-sub {
      font-size: 0.72rem;
      opacity: 0.85;
      line-height: 1.3;
    }
    .android-app-banner .aab-btn {
      flex-shrink: 0;
      background: rgba(255,255,255,0.95);
      color: #5b4ba8;
      font-size: 0.78rem;
      font-weight: 700;
      padding: 7px 14px;
      border-radius: 999px;
      text-decoration: none;
      white-space: nowrap;
    }
    .android-app-banner .aab-close {
      flex-shrink: 0;
      background: none;
      border: none;
      color: rgba(255,255,255,0.85);
      font-size: 1.1rem;
      line-height: 1;
      padding: 4px 2px 4px 6px;
      cursor: pointer;
    }

    /* ===== HEADER ===== */
    .app-header {
      position: sticky;
      top: 0;
      z-index: 50;
      background: var(--header-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      padding-top: max(12px, env(safe-area-inset-top));
    }
    .header-inner {
      max-width: 600px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .nav-btn {
      width: 36px;
      height: 36px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      color: var(--text-sub);
      transition: all 0.15s;
    }
    .nav-btn:active { transform: scale(0.9); background: var(--border); }
    .month-info { text-align: center; }
    .month-label {
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--text);
      line-height: 1.2;
    }
    .calendar-id {
      font-size: 0.7rem;
      color: var(--text-sub);
      letter-spacing: 0.03em;
    }
    .today-btn {
      padding: 8px 14px;
      border: 1.5px solid var(--border);
      background: var(--surface);
      border-radius: 20px;
      cursor: pointer;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-sub);
      transition: all 0.15s;
      white-space: nowrap;
    }
    .today-btn:active { background: var(--surface-2); transform: scale(0.95); }

    /* ===== CALENDAR GRID ===== */
    .calendar-wrap {
      max-width: 600px;
      margin: 0 auto;
      padding: 12px 12px;
      padding-bottom: calc(80px + var(--safe-bottom));
    }
    .day-headers {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      margin-bottom: 6px;
    }
    .day-header {
      text-align: center;
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text-sub);
      padding: 4px 0;
      letter-spacing: 0.05em;
    }
    .day-header:first-child { color: #f06565; }
    .day-header:last-child { color: var(--primary); }

    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 5px;
    }
    .day-cell {
      background: var(--surface);
      border-radius: var(--radius-sm);
      min-height: 72px;
      padding: 6px 5px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-sm);
      border: 1.5px solid transparent;
      transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
      position: relative;
      overflow: hidden;
    }
    .day-cell:active { transform: scale(0.94); }
    .day-cell.today {
      background: var(--today-bg);
      border-color: var(--today-border);
    }
    .day-cell.empty {
      background: transparent;
      box-shadow: none;
      cursor: default;
      border-color: transparent;
    }
    .day-cell:nth-child(7n+1) .date-num { color: #f06565; }
    .day-cell:nth-child(7n) .date-num { color: var(--primary); }

    .date-num {
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--text);
      line-height: 1;
      margin-bottom: 4px;
    }
    .today .date-num {
      background: var(--primary);
      color: white;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      margin-bottom: 4px;
    }

    .mini-bars {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
    }
    .mini-bar {
      height: 5px;
      border-radius: 3px;
      background: transparent;
      transition: background 0.2s;
    }
    .note-dot {
      width: 5px;
      height: 5px;
      background: var(--text-sub);
      border-radius: 50%;
      margin-top: auto;
      align-self: flex-end;
    }

    /* ===== MODAL ===== */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: none;
      align-items: flex-end;
      justify-content: center;
      z-index: 200;
      padding: 0;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: var(--surface);
      border-radius: 28px 28px 0 0;
      width: 100%;
      max-width: 600px;
      max-height: 92vh;
      overflow-y: auto;
      padding: 8px 20px 20px;
      padding-bottom: max(20px, var(--safe-bottom));
      box-shadow: 0 -4px 40px rgba(0,0,0,0.15);
      animation: slideUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes slideUp {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    .modal-handle {
      width: 40px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      margin: 0 auto 16px;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .modal-date {
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--text);
    }
    .modal-actions {
      display: flex;
      gap: 8px;
    }
    .icon-btn {
      width: 40px;
      height: 40px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      transition: all 0.15s;
    }
    .icon-btn:active { transform: scale(0.9); background: var(--border); }
    .icon-btn.camera-btn {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      font-size: 1rem;
    }
    .icon-btn.close-btn { font-size: 1.2rem; color: var(--text); }

    .period-row {
      display: grid;
      grid-template-columns: 32px 1fr;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .period-num {
      width: 32px;
      height: 32px;
      background: var(--surface-2);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--text-sub);
    }
    .subject-input {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid var(--border);
      border-radius: 12px;
      font-size: 1rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
      background: var(--surface-2);
    }
    .subject-input:focus { border-color: var(--primary); background: var(--input-focus-bg); }

    .note-section { margin-top: 8px; }
    .note-label {
      font-size: 0.78rem;
      font-weight: 700;
      color: var(--text-sub);
      letter-spacing: 0.05em;
      margin-bottom: 8px;
      display: block;
    }
    .note-area {
      width: 100%;
      height: 72px;
      padding: 10px 14px;
      border: 1.5px solid var(--border);
      border-radius: 12px;
      font-size: 0.95rem;
      font-family: inherit;
      outline: none;
      resize: none;
      background: var(--surface-2);
      transition: border-color 0.2s;
    }
    .note-area:focus { border-color: var(--primary); background: var(--input-focus-bg); }

    .modal-footer {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .btn-cancel {
      flex: 1;
      padding: 14px;
      border: 1.5px solid var(--border);
      background: var(--surface-2);
      border-radius: 14px;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-sub);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-save {
      flex: 2;
      padding: 14px;
      background: linear-gradient(135deg, var(--primary), #764ba2);
      color: white;
      border: none;
      border-radius: 14px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-save:active, .btn-cancel:active { transform: scale(0.97); opacity: 0.85; }

    /* ===== CAMERA MODAL ===== */
    .camera-overlay {
      position: fixed;
      inset: 0;
      background: black;
      z-index: 300;
      display: none;
      flex-direction: column;
    }
    .camera-overlay.active { display: flex; }
    .camera-stream {
      flex: 1;
      width: 100%;
      object-fit: cover;
      min-height: 0;
    }
    .camera-frame {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -55%);
      width: 85%;
      max-width: 400px;
      height: 55vh;
      border: 3px solid rgba(255,255,255,0.8);
      border-radius: 20px;
      box-shadow: 0 0 0 4000px rgba(0,0,0,0.5);
      pointer-events: none;
    }
    .camera-frame::before, .camera-frame::after {
      content: '';
      position: absolute;
      width: 24px;
      height: 24px;
      border-color: white;
      border-style: solid;
    }
    .camera-frame::before { top: -3px; left: -3px; border-width: 4px 0 0 4px; border-radius: 20px 0 0 0; }
    .camera-frame::after { bottom: -3px; right: -3px; border-width: 0 4px 4px 0; border-radius: 0 0 20px 0; }
    .camera-hint {
      position: absolute;
      top: calc(50% + 28vh);
      left: 50%;
      transform: translateX(-50%);
      color: white;
      font-size: 0.8rem;
      text-align: center;
      opacity: 0.7;
      white-space: nowrap;
    }
    .camera-controls {
      padding: 24px;
      padding-bottom: max(24px, var(--safe-bottom));
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(0,0,0,0.6);
      flex-shrink: 0;
    }
    .cam-close-btn {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      background: rgba(255,255,255,0.2);
      border: none;
      color: white;
      font-size: 1.3rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .shutter-btn {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: white;
      border: 4px solid rgba(255,255,255,0.6);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 0 4px rgba(255,255,255,0.3);
      transition: transform 0.1s;
    }
    .shutter-btn:active { transform: scale(0.9); }
    .shutter-inner {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: white;
    }
    .cam-placeholder { width: 50px; height: 50px; }

    /* ===== CONFIRM MODAL ===== */
    .confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(6px);
      z-index: 400;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .confirm-overlay.active { display: flex; }
    .confirm-card {
      background: var(--surface);
      border-radius: 24px;
      padding: 28px 24px;
      width: 100%;
      max-width: 380px;
      box-shadow: var(--shadow-lg);
      animation: popIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes popIn {
      from { transform: scale(0.85); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .confirm-icon {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #43e97b, #38f9d7);
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 16px;
    }
    .confirm-title {
      text-align: center;
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 20px;
    }
    .confirm-list {
      list-style: none;
      margin-bottom: 24px;
    }
    .confirm-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 12px;
      margin-bottom: 6px;
      background: var(--surface-2);
    }
    .confirm-period {
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--text-sub);
      min-width: 20px;
    }
    .confirm-subject {
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--chip-text);
    }
    .confirm-empty {
      font-size: 0.85rem;
      color: var(--text-sub);
      font-style: italic;
    }
    .confirm-footer {
      display: flex;
      gap: 10px;
    }
    .btn-confirm-cancel {
      flex: 1;
      padding: 14px;
      border: 1.5px solid var(--border);
      background: var(--surface-2);
      border-radius: 14px;
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-sub);
      cursor: pointer;
    }
    .btn-confirm-ok {
      flex: 2;
      padding: 14px;
      background: linear-gradient(135deg, #43e97b, #38f9d7);
      color: white;
      border: none;
      border-radius: 14px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
    }

    /* ===== LOADING ===== */
    .processing-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 500;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 16px;
    }
    .processing-overlay.active { display: flex; }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(255,255,255,0.2);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .processing-text { color: white; font-size: 0.9rem; font-weight: 600; }

    /* ===== SYNC STATUS ===== */
    .sync-toast {
      position: fixed;
      bottom: calc(16px + var(--safe-bottom));
      left: 50%;
      transform: translateX(-50%) translateY(80px);
      background: rgba(26,26,46,0.9);
      color: white;
      padding: 10px 20px;
      border-radius: 20px;
      font-size: 0.82rem;
      font-weight: 600;
      z-index: 800;
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      white-space: nowrap;
      pointer-events: none;
    }
    .sync-toast.visible { transform: translateX(-50%) translateY(0); }
    .sync-toast.error { background: rgba(220,53,69,0.9); }

    /* ===== VERSION BADGE ===== */
    .version-badge {
      position: fixed;
      left: max(10px, env(safe-area-inset-left));
      bottom: calc(8px + var(--safe-bottom));
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--text-sub);
      opacity: 0.45;
      z-index: 40;
      pointer-events: none;
      user-select: none;
      letter-spacing: 0.02em;
    }

    .notif-toast {
      position: fixed;
      top: max(16px, env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%) translateY(-80px);
      background: var(--surface);
      color: var(--text);
      padding: 12px 20px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
      z-index: 900;
      transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
      white-space: nowrap;
      pointer-events: auto;
      cursor: pointer;
      box-shadow: var(--shadow-md);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: calc(100vw - 40px);
    }
    .notif-toast.visible {
      transform: translateX(-50%) translateY(0);
    }

    /* ===== HOVER TOOLTIP (PCのみ) ===== */
    @media (hover: hover) and (pointer: fine) {
      .hover-tooltip {
        position: fixed;
        z-index: 999;
        background: var(--surface);
        border-radius: 16px;
        padding: 14px 16px;
        min-width: 160px;
        max-width: 220px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px) scale(0.97);
        transition: opacity 0.15s, transform 0.15s;
        border: 1px solid var(--border);
      }
      .hover-tooltip.visible {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    @media not all and (hover: hover) and (pointer: fine) {
      .hover-tooltip { display: none !important; }
    }
    .tooltip-date {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text-sub);
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .tooltip-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .tooltip-period {
      font-size: 0.65rem;
      font-weight: 700;
      color: var(--text-sub);
      min-width: 24px;
      text-align: center;
    }
    .tooltip-subject {
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--chip-text);
      padding: 2px 8px;
      border-radius: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
    }
    .tooltip-note {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--text-sub);
      line-height: 1.4;
    }
    .tooltip-empty {
      font-size: 0.8rem;
      color: var(--text-sub);
      text-align: center;
      padding: 4px 0;
    }

    /* ===== HEADER ACTIONS ===== */
    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header-pc-actions {
      display: none;
      align-items: center;
      gap: 8px;
    }
    .login-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      background: rgba(88,101,242,0.1);
      border: 1.5px solid rgba(88,101,242,0.3);
      border-radius: 20px;
      color: #5865F2;
      font-size: 0.78rem;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .login-btn:hover { background: rgba(88,101,242,0.18); }
    .login-btn.logged-in {
      background: rgba(88,101,242,0.08);
      color: #5865F2;
    }
    .settings-btn {
      width: 36px;
      height: 36px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      transition: all 0.15s;
    }
    .settings-btn:hover { background: var(--border); }
    .menu-btn {
      width: 36px;
      height: 36px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .menu-btn:hover { background: var(--border); }
    .menu-icon {
      width: 16px;
      height: 12px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .menu-icon span {
      display: block;
      width: 100%;
      height: 2px;
      border-radius: 2px;
      background: var(--text-sub);
    }
    /* PC幅: 設定・ログインをヘッダーに表示し、ハンバーガーは隠す */
    @media (min-width: 640px) {
      .header-pc-actions { display: flex; }
      .menu-btn { display: none; }
    }

    /* ===== ハンバーガーメニュー(モバイル用) ===== */
    .menu-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: none;
      align-items: flex-end;
      justify-content: center;
      z-index: 220;
    }
    .menu-overlay.active { display: flex; }
    .menu-panel {
      background: var(--surface);
      border-radius: 28px 28px 0 0;
      width: 100%;
      max-width: 600px;
      padding: 8px 16px 16px;
      padding-bottom: max(16px, var(--safe-bottom));
      box-shadow: 0 -4px 40px rgba(0,0,0,0.15);
      animation: slideUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 14px 12px;
      border: none;
      background: transparent;
      border-radius: 14px;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
      cursor: pointer;
      transition: background 0.15s;
      text-align: left;
    }
    .menu-item:hover, .menu-item:active { background: var(--surface-2); }
    .menu-item-icon {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
      flex-shrink: 0;
    }
    .menu-discord-icon { color: #5865F2; }
    .menu-item-label { flex: 1; }
    .menu-item-sub {
      font-size: 0.78rem;
      color: var(--text-sub);
      font-weight: 600;
    }

    /* ===== 掲示板ボタン ===== */
    .board-btn {
      width: 36px;
      height: 36px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      transition: all 0.15s;
      position: relative;
    }
    .board-btn:hover { background: var(--border); }
    .board-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      background: #f06565;
      color: white;
      font-size: 0.6rem;
      font-weight: 700;
      border-radius: 8px;
      padding: 1px 4px;
      min-width: 14px;
      text-align: center;
      display: none;
    }
    .board-badge.visible { display: block; }

    /* ===== 掲示板モーダル ===== */
    .board-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: none;
      align-items: flex-end;
      justify-content: center;
      z-index: 200;
    }
    .board-overlay.active { display: flex; }
    .board-modal {
      background: var(--surface);
      border-radius: 28px 28px 0 0;
      width: 100%;
      max-width: 600px;
      max-height: 92vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 -4px 40px rgba(0,0,0,0.15);
      animation: slideUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .board-modal-header {
      padding: 12px 20px 0;
      flex-shrink: 0;
    }
    .board-modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 0 16px 16px;
      padding-bottom: max(16px, var(--safe-bottom));
    }
    .board-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .board-title {
      font-size: 1.2rem;
      font-weight: 700;
      color: var(--text);
    }
    .upload-area {
      border: 2px dashed var(--border);
      border-radius: 16px;
      padding: 20px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      margin-bottom: 16px;
      background: var(--surface-2);
      position: relative;
    }
    .upload-area:hover, .upload-area.drag-over {
      border-color: var(--primary);
      background: rgba(102,126,234,0.05);
    }
    .upload-area input[type=file] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }
    .upload-icon { font-size: 2rem; margin-bottom: 6px; }
    .upload-label { font-size: 0.88rem; color: var(--text-sub); font-weight: 600; }
    .upload-sub { font-size: 0.75rem; color: var(--text-sub); margin-top: 4px; }
    .images-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .image-card {
      border-radius: 14px;
      overflow: hidden;
      background: var(--surface-2);
      position: relative;
      box-shadow: var(--shadow-sm);
      cursor: pointer;
    }
    .file-thumb {
      width: 100%;
      aspect-ratio: 4/3;
      background: var(--surface-2);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .file-thumb-icon { font-size: 2.4rem; }
    .file-thumb-name {
      font-size: 0.72rem;
      color: var(--text-sub);
      text-align: center;
      padding: 0 8px;
      word-break: break-all;
      max-height: 2.4em;
      overflow: hidden;
    }
    .image-card img {
      width: 100%;
      aspect-ratio: 4/3;
      object-fit: cover;
      display: block;
    }
    .image-card-footer {
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .img-new-badge {
      font-size: 0.6rem;
      font-weight: 800;
      color: white;
      background: #f06565;
      border-radius: 5px;
      padding: 1px 5px;
      flex-shrink: 0;
      letter-spacing: 0.05em;
    }
    .image-name {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .image-delete-btn {
      width: 24px;
      height: 24px;
      border: none;
      background: rgba(240,101,101,0.12);
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      flex-shrink: 0;
      color: #f06565;
    }
    .board-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-sub);
      font-size: 0.9rem;
    }
    .board-capacity-bar {
      margin: 0 0 14px;
    }
    .cap-info {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--text-sub);
      margin-bottom: 5px;
    }
    .cap-bar-bg {
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    .cap-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #43e97b, #667eea);
      border-radius: 3px;
      transition: width 0.4s;
    }
    .cap-bar-fill.warn { background: linear-gradient(90deg, #f6d365, #f06565); }
    .board-empty-icon { font-size: 3rem; margin-bottom: 12px; }
    .img-fullscreen {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.95);
      z-index: 600;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .img-fullscreen.active { display: flex; }
    .img-fullscreen img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 12px;
    }
    .img-fullscreen-close {
      position: absolute;
      top: max(16px, env(safe-area-inset-top));
      right: 16px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      border: none;
      color: white;
      font-size: 1.3rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* ===== チャットボタン ===== */
    .chat-btn {
      width: 36px;
      height: 36px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      transition: all 0.15s;
      position: relative;
    }
    .chat-btn:hover { background: var(--border); }
    .chat-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      background: #f06565;
      color: white;
      font-size: 0.6rem;
      font-weight: 700;
      border-radius: 8px;
      padding: 1px 4px;
      min-width: 14px;
      text-align: center;
      display: none;
    }
    .chat-badge.visible { display: block; }

    /* ===== チャットモーダル ===== */
    .chat-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: none;
      align-items: flex-end;
      justify-content: center;
      z-index: 210;
    }
    .chat-overlay.active { display: flex; }
    .chat-modal {
      background: var(--surface);
      border-radius: 28px 28px 0 0;
      width: 100%;
      max-width: 600px;
      height: 88vh;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 -4px 40px rgba(0,0,0,0.15);
      animation: slideUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .chat-modal-header {
      padding: 12px 20px;
      flex-shrink: 0;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .chat-title {
      font-size: 1.2rem;
      font-weight: 700;
      color: var(--text);
    }
    .chat-modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      position: relative;
    }
    #chatMessagesList {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 100%;
    }
    .chat-new-banner {
      position: sticky;
      top: -16px;
      margin: -16px -16px 4px -16px;
      padding: 10px 16px;
      background: var(--accent, #5865f2);
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      text-align: center;
      cursor: pointer;
      z-index: 5;
      display: none;
      align-items: center;
      justify-content: center;
      gap: 6px;
      animation: chatBannerIn 0.2s ease;
    }
    .chat-new-banner.visible { display: flex; }
    .chat-new-banner:active { opacity: 0.85; }
    @keyframes chatBannerIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .chat-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-sub);
      font-size: 0.9rem;
      margin: auto 0;
    }
    .chat-empty-icon { font-size: 3rem; margin-bottom: 12px; }
    .chat-msg {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      max-width: 88%;
    }
    .chat-msg.own {
      align-self: flex-end;
      flex-direction: row-reverse;
    }
    .chat-msg-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      flex-shrink: 0;
      object-fit: cover;
      background: var(--surface-2);
    }
    .chat-msg-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .chat-msg.own .chat-msg-body { align-items: flex-end; }
    .chat-msg-name {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text-sub);
      padding: 0 4px;
    }
    .chat-msg-bubble {
      background: var(--surface-2);
      border-radius: 14px;
      padding: 9px 13px;
      font-size: 0.92rem;
      color: var(--text);
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .chat-msg.own .chat-msg-bubble {
      background: var(--primary);
      color: white;
    }
    .chat-msg-bubble a {
      color: var(--primary);
      text-decoration: underline;
      word-break: break-all;
    }
    .chat-msg.own .chat-msg-bubble a { color: white; }
    .chat-msg-img {
      max-width: 220px;
      max-height: 220px;
      border-radius: 12px;
      cursor: pointer;
      display: block;
    }
    .chat-msg-time {
      font-size: 0.65rem;
      color: var(--text-sub);
      padding: 0 4px;
    }
    .chat-input-area {
      flex-shrink: 0;
      padding: 10px 12px;
      padding-bottom: max(10px, var(--safe-bottom));
      border-top: 1px solid var(--border);
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    .chat-attach-btn {
      width: 40px;
      height: 40px;
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      cursor: pointer;
      font-size: 1.1rem;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .chat-attach-btn input[type=file] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }
    .chat-text-input {
      flex: 1;
      border: 1.5px solid var(--border);
      border-radius: 20px;
      padding: 10px 16px;
      font-size: 0.92rem;
      resize: none;
      max-height: 100px;
      outline: none;
      background: var(--surface);
      color: var(--text);
      font-family: inherit;
      line-height: 1.4;
    }
    .chat-text-input:focus { border-color: var(--primary); }
    .chat-send-btn {
      width: 40px;
      height: 40px;
      border: none;
      background: var(--primary);
      color: white;
      border-radius: 50%;
      cursor: pointer;
      font-size: 1rem;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.15s;
    }
    .chat-send-btn:disabled { opacity: 0.4; cursor: default; }
    .chat-preview-bar {
      display: none;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
    }
    .chat-preview-bar.visible { display: flex; }
    .chat-preview-bar img {
      width: 48px;
      height: 48px;
      object-fit: cover;
      border-radius: 8px;
    }
    .chat-preview-remove {
      border: none;
      background: var(--surface-2);
      border-radius: 50%;
      width: 24px;
      height: 24px;
      cursor: pointer;
      font-size: 0.8rem;
      margin-left: auto;
    }

    /* ===== プロフィール設定モーダル ===== */
    .profile-card {
      background: var(--surface);
      border-radius: 24px;
      padding: 32px 28px;
      width: 100%;
      max-width: 360px;
      text-align: center;
    }
    .profile-icon-preview {
      width: 84px;
      height: 84px;
      border-radius: 50%;
      margin: 0 auto 16px;
      background: var(--surface-2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.2rem;
      position: relative;
      cursor: pointer;
      overflow: hidden;
      border: 2px dashed var(--border);
    }
    .profile-icon-preview img { width: 100%; height: 100%; object-fit: cover; }
    .profile-icon-preview input[type=file] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }
    .profile-icon-hint {
      font-size: 0.72rem;
      color: var(--text-sub);
      margin-bottom: 20px;
    }
    .profile-name-input {
      width: 100%;
      padding: 13px 16px;
      border: 1.5px solid var(--border);
      border-radius: 14px;
      font-size: 0.95rem;
      outline: none;
      margin-bottom: 20px;
      background: var(--surface);
      color: var(--text);
      text-align: center;
    }
    .profile-name-input:focus { border-color: var(--primary); }
    .profile-password-input {
      width: 100%;
      padding: 13px 16px;
      border: 1.5px solid var(--border);
      border-radius: 14px;
      font-size: 0.95rem;
      outline: none;
      margin-bottom: 14px;
      background: var(--surface);
      color: var(--text);
      text-align: center;
    }
    .profile-password-input:focus { border-color: var(--primary); }
    .profile-auth-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 18px;
      background: var(--surface-2);
      border-radius: 12px;
      padding: 4px;
    }
    .profile-auth-tab {
      flex: 1;
      padding: 9px 0;
      border: none;
      background: transparent;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-sub);
      cursor: pointer;
    }
    .profile-auth-tab.active {
      background: var(--surface);
      color: var(--text);
    }
    .profile-auth-error {
      font-size: 0.78rem;
      color: #e5484d;
      margin: -8px 0 14px;
      min-height: 1em;
    }
    .profile-auth-note {
      font-size: 0.7rem;
      color: var(--text-sub);
      margin-top: 14px;
      line-height: 1.5;
    }
    .profile-save-btn {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg,#667eea,#764ba2);
      color: white;
      border: none;
      border-radius: 14px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
    }
    .profile-save-btn:disabled { opacity: 0.6; cursor: default; }

    /* ===== 科目ボタンパレット ===== */
    .subject-palette {
      margin-bottom: 14px;
    }
    .palette-label {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text-sub);
      letter-spacing: 0.05em;
      margin-bottom: 8px;
      display: block;
    }
    .palette-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.82rem;
      font-weight: 700;
      border: none;
      cursor: grab;
      user-select: none;
      touch-action: none;
      transition: transform 0.1s, box-shadow 0.1s;
      white-space: nowrap;
      color: var(--chip-text);
    }
    .chip:active { transform: scale(0.93); }
    .chip.dragging {
      opacity: 0.5;
      cursor: grabbing;
    }
    .period-row.drag-over .subject-input {
      border-color: var(--primary);
      background: rgba(102,126,234,0.12);
      box-shadow: 0 0 0 3px rgba(102,126,234,0.2);
    }
    .chip-ghost {
      position: fixed;
      pointer-events: none;
      z-index: 9999;
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.82rem;
      font-weight: 700;
      box-shadow: 0 8px 24px rgba(0,0,0,0.2);
      transform: translate(-50%, -50%) scale(1.08);
      white-space: nowrap;
      color: var(--chip-text);
    }

    /* ===== SETTINGS MODAL ===== */
    .settings-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 250;
      padding: 20px;
    }
    .settings-overlay.active { display: flex; }
    .settings-card {
      background: var(--surface);
      border-radius: 24px;
      padding: 28px 24px;
      width: 100%;
      max-width: 380px;
      box-shadow: var(--shadow-lg);
      animation: popIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .settings-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 20px;
    }
    .settings-section-label {
      font-size: 0.78rem;
      font-weight: 700;
      color: var(--text-sub);
      letter-spacing: 0.05em;
      margin-bottom: 10px;
      display: block;
    }
    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 20px;
    }
    .radio-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border: 2px solid var(--border);
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .radio-option.selected {
      border-color: var(--primary);
      background: rgba(102,126,234,0.06);
    }
    .radio-option input[type=radio] { display: none; }
    .radio-dot {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s;
    }
    .radio-option.selected .radio-dot {
      border-color: var(--primary);
      background: var(--primary);
    }
    .radio-option.selected .radio-dot::after {
      content: '';
      width: 6px;
      height: 6px;
      background: white;
      border-radius: 50%;
    }
    .radio-text strong { display: block; font-size: 0.9rem; color: var(--text); }
    .radio-text span { font-size: 0.75rem; color: var(--text-sub); }
    .settings-footer {
      display: flex;
      gap: 10px;
      margin-top: 4px;
    }
    .btn-settings-cancel {
      flex: 1;
      padding: 13px;
      border: 1.5px solid var(--border);
      background: var(--surface-2);
      border-radius: 14px;
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-sub);
      cursor: pointer;
    }
    .btn-settings-save {
      flex: 2;
      padding: 13px;
      background: linear-gradient(135deg, var(--primary), #764ba2);
      color: white;
      border: none;
      border-radius: 14px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
    }
    .readonly-notice {
      background: rgba(255,193,7,0.12);
      border: 1.5px solid rgba(255,193,7,0.4);
      border-radius: 12px;
      padding: 10px 14px;
      font-size: 0.8rem;
      color: var(--readonly-text);
      margin-bottom: 16px;
      display: none;
    }
    .readonly-notice.visible { display: block; }

    /* ===== カスタムダイアログ ===== */
    .dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 700;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .dialog-overlay.active { display: flex; }
    .dialog-card {
      background: var(--surface);
      border-radius: 24px;
      padding: 28px 24px 24px;
      width: 100%;
      max-width: 340px;
      box-shadow: var(--shadow-lg);
      animation: popIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
      text-align: center;
    }
    .dialog-icon {
      font-size: 40px;
      margin-bottom: 12px;
      line-height: 1;
    }
    .dialog-title {
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 8px;
    }
    .dialog-message {
      font-size: 0.88rem;
      color: var(--text-sub);
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .dialog-btns {
      display: flex;
      gap: 10px;
    }
    .dialog-btns.single { justify-content: center; }
    .dialog-btn {
      flex: 1;
      padding: 13px;
      border-radius: 14px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s, transform 0.15s;
    }
    .dialog-btn:active { opacity: 0.8; transform: scale(0.97); }
    .dialog-btn.secondary {
      background: var(--surface-2);
      color: var(--text-sub);
      border: 1.5px solid var(--border);
    }
    .dialog-btn.primary {
      background: linear-gradient(135deg, var(--primary), #764ba2);
      color: white;
    }
    .dialog-btn.danger {
      background: linear-gradient(135deg, #f06565, #e74c3c);
      color: white;
    }
    .dialog-btn.safe {
      background: linear-gradient(135deg, #43e97b, #38f9d7);
      color: white;
    }
    /* ===== 隠し要素: dinnerbone (サイト反転) ===== */
    body.dinnerbone-mode {
      transform: rotate(180deg);
      transition: transform 0.6s ease;
    }
  </style>
  <script>
    (function() {
      try {
        var t = localStorage.getItem('themePref');
        if (t === 'light' || t === 'dark') {
          document.documentElement.setAttribute('data-theme', t);
        }
      } catch(e) {}
    })();
  </script>
</head>
<body>

  <div class="version-badge" id="versionBadge">v${APP_DISPLAY_VERSION}</div>

  <!-- Androidアプリダウンロード誘導バナー -->
  <div class="android-app-banner" id="androidAppBanner">
    <span class="aab-icon">📱</span>
    <div class="aab-text">
      <div class="aab-title">ホーム画面にウィジェットを置けるアプリがあります</div>
      <div class="aab-sub">Android専用アプリをダウンロード</div>
    </div>
    <a class="aab-btn" id="androidAppBannerBtn" href="https://github.com/Banana-Niku87729/Get_Rec877Pages/releases/download/tt-apk-1.00/timetable-calendar.apk" target="_blank" rel="noopener" onclick="dismissAndroidAppBanner()">入手する</a>
    <button class="aab-close" onclick="dismissAndroidAppBanner()" aria-label="閉じる">✕</button>
  </div>

  <!-- HEADER -->
  <header class="app-header">
    <div class="header-inner">
      <div class="month-info">
        <div class="month-label" id="monthLabel">読み込み中...</div>
        <div class="calendar-id" id="calendarIdLabel"></div>
      </div>
      <div class="header-right">
        <button class="today-btn" onclick="goToToday()">今日</button>
        <button class="chat-btn" onclick="openChat()" title="チャット">
          💬
          <span class="chat-badge" id="chatBadge"></span>
        </button>
        <button class="board-btn" onclick="openBoard()" title="掲示板・画像">
          🗒️
          <span class="board-badge" id="boardBadge"></span>
        </button>
        <div class="header-pc-actions">
          <button class="settings-btn" onclick="openThemePicker()" title="テーマ">🌓</button>
          ${isOwner ? `<button class="settings-btn" onclick="openSettings()" title="設定">⚙️</button>` : ''}
          ${session
            ? `<a href="/auth/logout" class="login-btn logged-in" title="ログアウト">
                 ${DISCORD_ICON_SVG}
                 ${htmlEscape(session.name)}
               </a>`
            : `<a href="/auth/login?redirect=${encodeURIComponent(url.pathname + url.search)}" class="login-btn">
                 ${DISCORD_ICON_SVG}
                 ログイン
               </a>`
          }
        </div>
        <button class="menu-btn" onclick="openMenu()" title="メニュー" aria-label="メニュー">
          <span class="menu-icon"><span></span><span></span><span></span></span>
        </button>
      </div>
    </div>
  </header>

  <!-- ハンバーガーメニュー(モバイル用) -->
  <div class="menu-overlay" id="menuOverlay" onclick="if(event.target===this)closeMenu()">
    <div class="menu-panel">
      <div class="menu-handle"></div>
      <button class="menu-item" onclick="closeMenu();openThemePicker()">
        <span class="menu-item-icon">🌓</span>
        <span class="menu-item-label">テーマ</span>
        <span class="menu-item-sub" id="themeMenuSub"></span>
      </button>
      ${isOwner ? `
      <button class="menu-item" onclick="closeMenu();openSettings()">
        <span class="menu-item-icon">⚙️</span>
        <span class="menu-item-label">カレンダー設定</span>
      </button>` : ''}
      ${session
        ? `<a href="/auth/logout" class="menu-item">
             <span class="menu-item-icon menu-discord-icon">${DISCORD_ICON_SVG}</span>
             <span class="menu-item-label">${htmlEscape(session.name)}としてログイン中</span>
             <span class="menu-item-sub">ログアウト</span>
           </a>`
        : `<a href="/auth/login?redirect=${encodeURIComponent(url.pathname + url.search)}" class="menu-item">
             <span class="menu-item-icon menu-discord-icon">${DISCORD_ICON_SVG}</span>
             <span class="menu-item-label">Discordでログイン</span>
           </a>`
      }
    </div>
  </div>

  <!-- テーマ選択モーダル -->
  <div class="settings-overlay" id="themeOverlay" onclick="if(event.target===this)closeThemePicker()">
    <div class="settings-card">
      <div class="settings-title">🌓 テーマ</div>
      <div class="radio-group">
        <label class="radio-option" id="theme-opt-system" onclick="selectTheme('system')">
          <input type="radio" name="themeMode" value="system">
          <div class="radio-dot"></div>
          <div class="radio-text">
            <strong>システム</strong>
            <span>端末の設定に合わせて自動切り替え</span>
          </div>
        </label>
        <label class="radio-option" id="theme-opt-light" onclick="selectTheme('light')">
          <input type="radio" name="themeMode" value="light">
          <div class="radio-dot"></div>
          <div class="radio-text">
            <strong>ホワイトモード</strong>
            <span>常に明るい配色で表示</span>
          </div>
        </label>
        <label class="radio-option" id="theme-opt-dark" onclick="selectTheme('dark')">
          <input type="radio" name="themeMode" value="dark">
          <div class="radio-dot"></div>
          <div class="radio-text">
            <strong>ダークモード</strong>
            <span>常に暗い配色で表示</span>
          </div>
        </label>
      </div>
      <div class="settings-footer">
        <button class="btn-settings-save" style="width:100%" onclick="closeThemePicker()">閉じる</button>
      </div>
    </div>
  </div>


  <!-- CALENDAR -->
  <div class="calendar-wrap">
    <div class="day-headers">
      <div class="day-header">日</div>
      <div class="day-header">月</div>
      <div class="day-header">火</div>
      <div class="day-header">水</div>
      <div class="day-header">木</div>
      <div class="day-header">金</div>
      <div class="day-header">土</div>
    </div>
    <div class="calendar-grid" id="calendarGrid"></div>
  </div>

  <!-- EDIT MODAL -->
  <div class="modal-overlay" id="editModal" onclick="if(event.target===this)requestCloseModal()">
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="modal-header">
        <div class="modal-date" id="modalDateLabel"></div>
        <div class="modal-actions">
          <button class="icon-btn camera-btn" onclick="openCamera()" title="カメラで読み取り">📷</button>
          <button class="icon-btn close-btn" onclick="requestCloseModal()">✕</button>
        </div>
      </div>
      <div id="periodInputs"></div>
      <div class="note-section">
        <span class="note-label">備考</span>
        <textarea id="noteInput" class="note-area" placeholder="メモを入力..."></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn-cancel" onclick="requestCloseModal()">キャンセル</button>
        <button class="btn-save" onclick="saveDay()">保存</button>
      </div>
    </div>
  </div>

  <!-- CAMERA MODAL -->
  <div class="camera-overlay" id="cameraOverlay">
    <video class="camera-stream" id="cameraVideo" autoplay playsinline muted></video>
    <div class="camera-frame"></div>
    <div class="camera-hint">時間割表の枠内に合わせてください</div>
    <canvas id="captureCanvas" style="display:none"></canvas>
    <div class="camera-controls">
      <button class="cam-close-btn" onclick="closeCamera()">✕</button>
      <button class="shutter-btn" onclick="capturePhoto()" aria-label="撮影">
        <div class="shutter-inner"></div>
      </button>
      <div class="cam-placeholder"></div>
    </div>
  </div>

  <!-- SCAN CONFIRM MODAL -->
  <div class="confirm-overlay" id="confirmOverlay">
    <div class="confirm-card">
      <div class="confirm-icon">✅</div>
      <div class="confirm-title">この内容で入力を完了しますか？</div>
      <ul class="confirm-list" id="confirmList"></ul>
      <div class="confirm-footer">
        <button class="btn-confirm-cancel" onclick="closeConfirm()">撮り直す</button>
        <button class="btn-confirm-ok" onclick="applyScannedData()">適用する</button>
      </div>
    </div>
  </div>

  <!-- PROCESSING -->
  <div class="processing-overlay" id="processingOverlay">
    <div class="spinner"></div>
    <div class="processing-text">時間割を読み取り中...</div>
  </div>

  <!-- SYNC TOAST -->
  <div class="sync-toast" id="syncToast">保存完了</div>

  <!-- アプリ内通知トースト -->
  <div class="notif-toast" id="notifToast" onclick="handleNotifClick()">
    <span id="notifIcon">💬</span>
    <span id="notifText"></span>
  </div>

  <!-- READONLY NOTICE -->
  <div class="readonly-notice" id="readonlyNotice">
    🔒 このカレンダーはDiscordログインが必要です。<a href="/auth/login" style="color:inherit;font-weight:700">ログイン</a>すると編集できます。
  </div>

  <!-- HOVER TOOLTIP (PCのみ有効) -->
  <div class="hover-tooltip" id="hoverTooltip"></div>

  <!-- SETTINGS MODAL -->
  <div class="settings-overlay" id="settingsOverlay" onclick="if(event.target===this)closeSettings()">
    <div class="settings-card">
      <div class="settings-title">⚙️ カレンダー設定</div>
      <span class="settings-section-label">編集できる人</span>
      <div class="radio-group">
        <label class="radio-option" id="opt-all" onclick="selectEditMode('all')">
          <input type="radio" name="editMode" value="all">
          <div class="radio-dot"></div>
          <div class="radio-text">
            <strong>全員</strong>
            <span>URLを知っていれば誰でも編集できます</span>
          </div>
        </label>
        <label class="radio-option" id="opt-discord" onclick="selectEditMode('discord')">
          <input type="radio" name="editMode" value="discord">
          <div class="radio-dot"></div>
          <div class="radio-text">
            <strong>Discordでログインしている人</strong>
            <span>ログインしていないと閲覧のみになります</span>
          </div>
        </label>
      </div>
      <div class="settings-footer">
        <button class="btn-settings-cancel" onclick="closeSettings()">キャンセル</button>
        <button class="btn-settings-save" onclick="saveSettings()">保存する</button>
      </div>
    </div>
  </div>

  <!-- 掲示板モーダル -->
  <div class="board-overlay" id="boardOverlay" onclick="if(event.target===this)closeBoard()">
    <div class="board-modal">
      <div class="board-modal-header">
        <div class="modal-handle"></div>
        <div class="board-title-row">
          <div class="board-title">🗒️ 掲示板</div>
          <button class="icon-btn close-btn" onclick="closeBoard()">✕</button>
        </div>
        ${canEdit ? `
        <div class="upload-area" id="uploadArea">
          <input type="file" accept="image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx" multiple onchange="handleFileSelect(event)">
          <div class="upload-icon">📎</div>
          <div class="upload-label">タップしてファイルを追加</div>
          <div class="upload-sub" id="boardCapacity">給食表・お知らせ・時間割など（最大50件）</div>
        </div>` : ''}
        <div class="board-capacity-bar" id="boardCapacityBar" style="display:none">
          <div class="cap-info">
            <span id="capText">0 / 50</span>
            <span id="capRemain">残り: 50</span>
          </div>
          <div class="cap-bar-bg"><div class="cap-bar-fill" id="capBarFill"></div></div>
        </div>
      </div>
      <div class="board-modal-body">
        <div class="images-grid" id="imagesGrid">
          <div class="board-empty">
            <div class="board-empty-icon">📭</div>
            読み込み中...
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- チャットモーダル -->
  <div class="chat-overlay" id="chatOverlay" onclick="if(event.target===this)closeChat()">
    <div class="chat-modal">
      <div class="chat-modal-header">
        <div class="chat-title">💬 チャット</div>
        <div style="display:flex;align-items:center;gap:4px">
          <button class="icon-btn" id="chatLogoutBtn" onclick="logoutChatAccount()" title="ログアウト" style="display:none">🚪</button>
          <button class="icon-btn close-btn" onclick="closeChat()">✕</button>
        </div>
      </div>
      <div class="chat-modal-body" id="chatBody">
        <div class="chat-new-banner" id="chatNewBanner" onclick="jumpToLatestChat()">
          <span id="chatNewBannerText">新しいメッセージ</span> ↓
        </div>
        <div id="chatMessagesList">
          <div class="chat-empty">
            <div class="chat-empty-icon">💬</div>
            読み込み中...
          </div>
        </div>
      </div>
      <div class="chat-preview-bar" id="chatPreviewBar">
        <img id="chatPreviewImg" src="" alt="">
        <button class="chat-preview-remove" onclick="removeChatAttachment()">✕</button>
      </div>
      <div class="chat-input-area">
        <button class="chat-attach-btn" title="画像を添付">
          📎
          <input type="file" accept="image/*" onchange="handleChatImageSelect(event)">
        </button>
        <textarea class="chat-text-input" id="chatTextInput" placeholder="メッセージを入力..." rows="1" onkeydown="handleChatKeydown(event)" oninput="autoGrowChatInput(this)"></textarea>
        <button class="chat-send-btn" id="chatSendBtn" onclick="sendChatMessage()">➤</button>
      </div>
    </div>
  </div>

  <!-- プロフィール設定モーダル(初回チャット利用時) -->
  <div class="chat-overlay" id="profileOverlay" style="align-items:center" onclick="if(event.target===this)closeProfileSetup()">
    <div class="profile-card" style="position:relative">
      <button onclick="closeProfileSetup()" style="position:absolute;top:12px;right:12px;width:32px;height:32px;border:none;background:var(--surface-2);border-radius:50%;cursor:pointer;font-size:1rem;color:var(--text)">✕</button>
      <div class="profile-icon-preview" id="profileIconPreview">
        <span id="profileIconPlaceholder">🙂</span>
        <input type="file" accept="image/*" id="profileIconInput" onchange="handleProfileIconSelect(event)">
      </div>
      <div class="profile-icon-hint">タップしてアイコンを設定（任意）</div>
      <div class="profile-auth-tabs">
        <button type="button" class="profile-auth-tab active" id="authTabRegister" onclick="switchAuthMode('register')">新規登録</button>
        <button type="button" class="profile-auth-tab" id="authTabLogin" onclick="switchAuthMode('login')">ログイン</button>
      </div>
      <input type="text" class="profile-name-input" id="profileNameInput" placeholder="表示名を入力" maxlength="20">
      <input type="password" class="profile-password-input" id="profilePasswordInput" placeholder="パスワード（4文字以上）" maxlength="100">
      <div class="profile-auth-error" id="profileAuthError"></div>
      <button class="profile-save-btn" id="profileSaveBtn" onclick="saveProfileSetup()">登録してチャットを始める</button>
      <div class="profile-auth-note">⚠️ パスワードを忘れた場合の再発行はできません。忘れない場所に控えておいてください。</div>
    </div>
  </div>

  <!-- 画像フルスクリーン -->
  <div class="img-fullscreen" id="imgFullscreen" onclick="closeFullscreen()">
    <button class="img-fullscreen-close" onclick="closeFullscreen()">✕</button>
    <img id="fullscreenImg" src="" alt="">
  </div>

  <!-- カスタムダイアログ -->
  <div class="dialog-overlay" id="dialogOverlay">
    <div class="dialog-card">
      <div class="dialog-icon" id="dialogIcon"></div>
      <div class="dialog-title" id="dialogTitle"></div>
      <div class="dialog-message" id="dialogMessage"></div>
      <div class="dialog-btns" id="dialogBtns"></div>
    </div>
  </div>

<script>
const CALENDAR_ID = ${JSON.stringify(calendarId)};
const PASSWORD = ${JSON.stringify(password)};
const META_TITLE = ${JSON.stringify(meta.title)};
const PERIODS = 6;
const CAN_EDIT = ${JSON.stringify(canEdit)};
const IS_OWNER = ${JSON.stringify(isOwner)};
const EDIT_MODE = ${JSON.stringify(editMode)};
const DISCORD_LOGGED_IN = ${JSON.stringify(!!session)};
const DISCORD_ID = ${JSON.stringify(session ? session.id : null)};
const DISCORD_NAME = ${JSON.stringify(session ? session.name : null)};
const DISCORD_AVATAR = ${JSON.stringify(session ? session.avatar : null)};

let scheduleData = {};
let scheduleDataVer = "0";
let currentDate = new Date();
let selectedDateKey = null;
let cameraStream = null;
let scannedPeriods = {};
let currentEditMode = EDIT_MODE;
let boardImages = [];
let chatMessages = [];
let chatAttachmentDataUrl = null;
let chatPollTimer = null;
let chatProfile = null; // { name, avatar, authToken, isDiscord }

// 編集中スナップショット（モーダルを開いた時点のデータ）
let editSnapshot = null;

const grid = document.getElementById('calendarGrid');
const monthLabel = document.getElementById('monthLabel');
const calendarIdLabel = document.getElementById('calendarIdLabel');
const syncToast = document.getElementById('syncToast');

// ===== カスタムダイアログ =====
let _dialogResolve = null;

/**
 * showDialog({ icon, title, message, buttons: [{label, style, value}] })
 * style: 'primary' | 'secondary' | 'danger' | 'safe'
 * resolve: 押されたボタンの value
 */


function showDialog({ icon = '', title = '', message = '', buttons = [] }) {
  return new Promise(resolve => {
    _dialogResolve = resolve;
    document.getElementById('dialogIcon').textContent = icon;
    document.getElementById('dialogTitle').textContent = title;
    document.getElementById('dialogMessage').textContent = message;
    const btns = document.getElementById('dialogBtns');
    btns.innerHTML = '';
    btns.className = 'dialog-btns' + (buttons.length === 1 ? ' single' : '');
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'dialog-btn ' + (b.style || 'secondary');
      btn.textContent = b.label;
      btn.onclick = () => closeDialog(b.value);
      btns.appendChild(btn);
    });
    document.getElementById('dialogOverlay').classList.add('active');
  });
}

function closeDialog(value) {
  document.getElementById('dialogOverlay').classList.remove('active');
  if (_dialogResolve) { _dialogResolve(value); _dialogResolve = null; }
}

// ===== COLOR =====
function stringToColor(str) {
  if (!str) return 'transparent';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const root = getComputedStyle(document.documentElement);
  const sat = (root.getPropertyValue('--chip-sat') || '70%').trim();
  const light = (root.getPropertyValue('--chip-light') || '82%').trim();
  return \`hsl(\${Math.abs(hash % 360)}, \${sat}, \${light})\`;
}
function updateInputStyle(input) {
  if (input.value.trim()) {
    input.style.background = stringToColor(input.value.trim());
    input.style.borderColor = 'transparent';
    input.style.color = 'var(--chip-text)';
  } else {
    input.style.background = '';
    input.style.borderColor = '';
    input.style.color = '';
  }
}

// ===== READONLY NOTICE =====
if (!CAN_EDIT && EDIT_MODE === "discord") {
  const notice = document.getElementById('readonlyNotice');
  if (notice) notice.classList.add('visible');
}

// ===== HOVER TOOLTIP =====
const tooltip = document.getElementById('hoverTooltip');
let tooltipTimer = null;
const isPointerDevice = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function showTooltip(cell, key, y, m, d) {
  if (!isPointerDevice) return;
  clearTimeout(tooltipTimer);
  const data = scheduleData[key] || { periods: {}, note: '' };
  const hasPeriods = Object.values(data.periods || {}).some(v => v);
  if (!hasPeriods && !data.note) return;

  let html = '<div class="tooltip-date">' + m + '月' + d + '日</div>';
  let anySubject = false;
  for (let i = 1; i <= PERIODS; i++) {
    const subj = data.periods && data.periods[i] ? data.periods[i] : '';
    if (subj) {
      anySubject = true;
      html += '<div class="tooltip-row"><span class="tooltip-period">' + i + '限</span><span class="tooltip-subject" style="background:' + stringToColor(subj) + '">' + subj + '</span></div>';
    }
  }
  if (!anySubject) html += '<div class="tooltip-empty">授業なし</div>';
  if (data.note) html += '<div class="tooltip-note">📝 ' + data.note + '</div>';

  tooltip.innerHTML = html;
  tooltip.classList.add('visible');

  const rect = cell.getBoundingClientRect();
  const tw = 220, th = 200;
  let left = rect.right + 8;
  let top = rect.top;
  if (left + tw > window.innerWidth - 8) left = rect.left - tw - 8;
  if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
  if (top < 8) top = 8;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideTooltip() {
  if (!isPointerDevice) return;
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => tooltip.classList.remove('visible'), 80);
}

// ===== MENU =====
function openMenu() {
  document.getElementById('menuOverlay').classList.add('active');
}
function closeMenu() {
  document.getElementById('menuOverlay').classList.remove('active');
}

// ===== THEME =====
const THEME_LABELS = { system: 'システム', light: 'ホワイト', dark: 'ダーク' };
function getThemePref() {
  try {
    const t = localStorage.getItem('themePref');
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch(e) {}
  return 'system';
}
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const sub = document.getElementById('themeMenuSub');
  if (sub) sub.textContent = THEME_LABELS[mode] || '';
}
function highlightThemeOption(mode) {
  document.querySelectorAll('.radio-option[id^="theme-opt-"]').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById('theme-opt-' + mode);
  if (el) el.classList.add('selected');
}
function selectTheme(mode) {
  try { localStorage.setItem('themePref', mode); } catch(e) {}
  applyTheme(mode);
  highlightThemeOption(mode);
}
function openThemePicker() {
  highlightThemeOption(getThemePref());
  document.getElementById('themeOverlay').classList.add('active');
}
function closeThemePicker() {
  document.getElementById('themeOverlay').classList.remove('active');
  location.reload();
}
applyTheme(getThemePref());

// ===== SETTINGS =====
function openSettings() {
  if (!IS_OWNER) return;
  selectEditMode(currentEditMode);
  document.getElementById('settingsOverlay').classList.add('active');
}
function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('active');
}
function selectEditMode(mode) {
  document.querySelectorAll('.radio-option').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById('opt-' + mode);
  if (el) el.classList.add('selected');
  currentEditMode = mode;
}
async function saveSettings() {
  try {
    const res = await fetch(\`/api/settings?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ editMode: currentEditMode })
    });
    if (res.ok) {
      showToast('✓ 設定を保存しました');
      closeSettings();
    } else if (res.status === 403) {
      showToast('⚠️ オーナーのみ変更できます', true);
    } else {
      showToast('⚠️ 保存エラー', true);
    }
  } catch(e) {
    showToast('⚠️ 保存エラー', true);
  }
}

// ===== DATA =====
async function loadData() {
  try {
    const res = await fetch(\`/api/sync?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
    if (res.ok) {
      const json = await res.json();
      scheduleData = json.data || {};
      scheduleDataVer = json.ver || "0";
    }
  } catch(e) { console.error(e); }
  renderCalendar();
}
async function saveData() {
  showToast('保存中...');
  try {
    await fetch(\`/api/sync?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`, {
      method: 'POST', body: JSON.stringify(scheduleData)
    });
    // 自分が保存した内容を即時バージョンに反映し、直後のポーリングで誤って再読込しないようにする
    try {
      const vres = await fetch(\`/api/sync/version?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
      if (vres.ok) { scheduleDataVer = (await vres.json()).ver || scheduleDataVer; }
    } catch(e) {}
    showToast('✓ 保存完了');
  } catch(e) {
    showToast('⚠️ 保存エラー', true);
  }
}
async function bgPollSchedule() {
  // 編集モーダルが開いている間は上書きしない（編集中のデータが消えるのを防ぐ）
  const editingOpen = document.getElementById('editModal') &&
    document.getElementById('editModal').classList.contains('active');
  if (editingOpen) return;
  try {
    const res = await fetch(\`/api/sync/version?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
    if (!res.ok) return;
    const { ver } = await res.json();
    if (ver && ver !== scheduleDataVer) {
      await loadData();
      showToast('🔄 時間割が更新されました');
    }
  } catch(e) {}
}
function showToast(msg, isError = false) {
  syncToast.textContent = msg;
  syncToast.classList.toggle('error', isError);
  syncToast.classList.add('visible');
  clearTimeout(syncToast._t);
  syncToast._t = setTimeout(() => syncToast.classList.remove('visible'), 1600);
}

// ===== RENDER =====
function renderCalendar() {
  // 重力イースターエッグ等で書き換えられたグリッドコンテナのインラインスタイルをリセット
  grid.style.display = '';
  grid.style.position = '';
  grid.style.height = '';
  grid.style.minHeight = '';
  grid.innerHTML = '';
  const y = currentDate.getFullYear(), m = currentDate.getMonth();
  monthLabel.textContent = \`\${y}年 \${m + 1}月\`;
  calendarIdLabel.textContent = \`\${META_TITLE} (ID: \${CALENDAR_ID})\`;

  const firstDay = new Date(y, m, 1).getDay();
  const lastDate = new Date(y, m + 1, 0).getDate();
  const today = new Date();

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'day-cell empty';
    grid.appendChild(el);
  }

  for (let d = 1; d <= lastDate; d++) {
    const key = \`\${y}-\${m + 1}-\${d}\`;
    const data = scheduleData[key] || { periods: {}, note: '' };
    const isToday = y === today.getFullYear() && m === today.getMonth() && d === today.getDate();

    const cell = document.createElement('div');
    cell.className = 'day-cell' + (isToday ? ' today' : '');

    const dateEl = document.createElement('div');
    dateEl.className = 'date-num';
    if (isToday) {
      const span = document.createElement('div');
      span.className = 'date-num';
      span.style.cssText = 'background:var(--primary);color:white;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.72rem;margin-bottom:4px';
      span.textContent = d;
      cell.appendChild(span);
    } else {
      dateEl.textContent = d;
      cell.appendChild(dateEl);
    }

    const bars = document.createElement('div');
    bars.className = 'mini-bars';
    for (let p = 1; p <= PERIODS; p++) {
      const subj = data.periods && data.periods[p] ? data.periods[p] : '';
      const bar = document.createElement('div');
      bar.className = 'mini-bar';
      bar.style.background = subj ? stringToColor(subj) : 'transparent';
      bars.appendChild(bar);
    }
    if (data.note) {
      const dot = document.createElement('div');
      dot.className = 'note-dot';
      bars.appendChild(dot);
    }
    cell.appendChild(bars);

    if (isPointerDevice) {
      cell.addEventListener('mouseenter', () => showTooltip(cell, key, y, m + 1, d));
      cell.addEventListener('mouseleave', hideTooltip);
    }

    cell.onclick = () => {
      if (!CAN_EDIT) {
        if (EDIT_MODE === "discord") showToast('🔒 編集にはログインが必要です', true);
        return;
      }
      openEditor(key, y, m + 1, d);
    };
    grid.appendChild(cell);
  }
}

// ===== 編集中かどうかチェック =====
function isEditing() {
  if (!editSnapshot) return false;
  // 現在の入力値とスナップショットを比較
  for (let i = 1; i <= PERIODS; i++) {
    const inp = document.getElementById(\`p-\${i}\`);
    const current = inp ? inp.value.trim() : '';
    const snap = editSnapshot.periods[i] || '';
    if (current !== snap) return true;
  }
  const noteInp = document.getElementById('noteInput');
  const currentNote = noteInp ? noteInp.value.trim() : '';
  if (currentNote !== (editSnapshot.note || '')) return true;
  return false;
}

// ===== EDITOR =====
const DEFAULT_SUBJECTS = ['国語','数学','英語','理科','社会','音楽','図工','体育','道徳','学活','総合','技術','家庭'];

function getSubjectPalette() {
  const used = new Set();
  Object.values(scheduleData).forEach(day => {
    Object.values(day.periods || {}).forEach(s => { if (s) used.add(s); });
  });
  const extra = [...used].filter(s => !DEFAULT_SUBJECTS.includes(s));
  return [...DEFAULT_SUBJECTS, ...extra];
}

function openEditor(key, y, m, d) {
  selectedDateKey = key;
  document.getElementById('modalDateLabel').textContent = \`\${m}月\${d}日\`;
  const data = scheduleData[key] || { periods: {}, note: '' };

  // スナップショット保存
  const snapPeriods = {};
  for (let i = 1; i <= PERIODS; i++) snapPeriods[i] = (data.periods && data.periods[i]) || '';
  editSnapshot = { periods: snapPeriods, note: data.note || '' };

  const container = document.getElementById('periodInputs');
  container.innerHTML = '';

  const palette = document.createElement('div');
  palette.className = 'subject-palette';
  palette.innerHTML = '<span class="palette-label">科目 — ドラッグして入力欄へ</span><div class="palette-chips" id="paletteChips"></div>';
  container.appendChild(palette);

  const chips = document.getElementById('paletteChips');
  getSubjectPalette().forEach(subj => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = subj;
    chip.style.background = stringToColor(subj);
    chip.draggable = true;
    setupChipDrag(chip, subj);
    chips.appendChild(chip);
  });

  for (let i = 1; i <= PERIODS; i++) {
    const val = (data.periods && data.periods[i]) || '';
    const row = document.createElement('div');
    row.className = 'period-row';
    row.dataset.period = i;
    row.innerHTML = \`
      <div class="period-num">\${i}</div>
      <input type="text" class="subject-input" id="p-\${i}" value="\${val}"
             placeholder="科目名" oninput="updateInputStyle(this)" autocomplete="off">
    \`;
    const inp = row.querySelector('input');
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const subj = e.dataTransfer.getData('text/plain');
      if (subj) { inp.value = subj; updateInputStyle(inp); }
    });
    container.appendChild(row);
    setTimeout(() => updateInputStyle(inp), 0);
  }

  document.getElementById('noteInput').value = data.note || '';
  document.getElementById('editModal').classList.add('active');
}

// ===== モーダルを閉じる（編集中なら確認） =====
async function requestCloseModal() {
  if (isEditing()) {
    const result = await showDialog({
      icon: '⚠️',
      title: '編集中の内容があります',
      message: '変更を破棄してもよいですか？',
      buttons: [
        { label: '編集に戻る', style: 'secondary', value: 'back' },
        { label: '破棄する', style: 'danger', value: 'discard' }
      ]
    });
    if (result !== 'discard') return;
  }
  closeModal();
}

function closeModal() {
  document.getElementById('editModal').classList.remove('active');
  editSnapshot = null;
}

function saveDay() {
  const periods = {};
  let hasData = false;
  for (let i = 1; i <= PERIODS; i++) {
    const val = document.getElementById(\`p-\${i}\`).value.trim();
    if (val) { periods[i] = val; hasData = true; }
  }
  const note = document.getElementById('noteInput').value.trim();
  if (note) hasData = true;
  if (hasData) scheduleData[selectedDateKey] = { periods, note };
  else delete scheduleData[selectedDateKey];
  closeModal();
  renderCalendar();
  saveData();
}

function changeMonth(d) { currentDate.setMonth(currentDate.getMonth() + d); renderCalendar(); }
function goToToday() { currentDate = new Date(); renderCalendar(); }

// ===== スワイプ =====
(function() {
  let sx = 0, sy = 0, moved = false;
  const THRESHOLD = 55;
  const RATIO = 1.8;

  document.getElementById('calendarGrid').addEventListener('touchstart', e => {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    moved = false;
  }, { passive: true });

  document.getElementById('calendarGrid').addEventListener('touchmove', e => {
    moved = true;
  }, { passive: true });

  document.getElementById('calendarGrid').addEventListener('touchend', e => {
    if (!moved) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx > THRESHOLD && adx > ady * RATIO) changeMonth(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', e => {
    const anyOpen = ['editModal','boardOverlay','settingsOverlay','menuOverlay','confirmOverlay','cameraOverlay','imgFullscreen','dialogOverlay','chatOverlay','profileOverlay']
      .some(id => document.getElementById(id)?.classList.contains('active'));
    if (anyOpen) return;
    if (e.key === 'ArrowLeft')  changeMonth(-1);
    if (e.key === 'ArrowRight') changeMonth(1);
  });
})();

// ===== イースターエッグ: 重力カレンダー (上上下下左右左右) =====
(function() {
  const KONAMI = ['up','up','down','down','left','right','left','right'];
  let progress = 0;
  let triggered = false;

  function isAnyOverlayOpen() {
    return ['editModal','boardOverlay','settingsOverlay','menuOverlay','confirmOverlay','cameraOverlay','imgFullscreen','dialogOverlay','chatOverlay','profileOverlay']
      .some(id => document.getElementById(id)?.classList.contains('active'));
  }

  function feedInput(dir) {
    if (isAnyOverlayOpen() || triggered) { progress = 0; return; }
    if (dir === KONAMI[progress]) {
      progress++;
      if (progress === KONAMI.length) {
        progress = 0;
        triggerGravity();
      }
    } else {
      // やり直し判定: 入力が先頭と一致するなら1からカウント
      progress = (dir === KONAMI[0]) ? 1 : 0;
    }
  }

  function triggerGravity() {
    if (triggered) return;
    triggered = true;

    const grid = document.getElementById('calendarGrid');
    if (!grid) { triggered = false; return; }

    const cells = Array.from(grid.children).filter(c => !c.classList.contains('empty'));
    if (cells.length === 0) { triggered = false; return; }

    const gridRect = grid.getBoundingClientRect();

    // 先に各セルの「現在の見た目上のサイズ・位置」を全部measureしてから
    // grid自体のレイアウトモードを無効化する（測定後でないと位置がズレる）
    const measurements = cells.map(cell => {
      const r = cell.getBoundingClientRect();
      return {
        cell,
        left: r.left - gridRect.left,
        top: r.top - gridRect.top,
        width: r.width,
        height: r.height
      };
    });

    // grid-template-columns由来の暗黙ストレッチで子要素が伸びてしまうのを防ぐため
    // コンテナをdisplay:blockに切り替えてからabsolute配置する
    grid.style.display = 'block';
    grid.style.position = 'relative';
    grid.style.height = gridRect.height + 'px';

    const floorY = window.innerHeight - gridRect.top + 40;
    let maxDuration = 0;

    measurements.forEach(({ cell, left, top, width, height }, i) => {
      cell.style.position = 'absolute';
      cell.style.left = left + 'px';
      cell.style.top = top + 'px';
      cell.style.width = width + 'px';
      cell.style.height = height + 'px';
      cell.style.maxWidth = width + 'px';
      cell.style.maxHeight = height + 'px';
      cell.style.boxSizing = 'border-box';
      cell.style.margin = '0';
      cell.style.zIndex = String(100 + i);
      cell.style.willChange = 'transform';
      cell.style.pointerEvents = 'none';

      const fallDistance = floorY - top;
      const rotate = (Math.random() * 140 - 70).toFixed(1);
      const drift = (Math.random() * 60 - 30).toFixed(0);
      const delay = Math.random() * 220;
      const duration = 650 + Math.random() * 500;
      maxDuration = Math.max(maxDuration, delay + duration);

      cell.style.transition = 'none';
      requestAnimationFrame(() => {
        setTimeout(() => {
          cell.style.transition = \`transform \${duration}ms cubic-bezier(0.55, 0, 1, 0.45)\`;
          cell.style.transform = \`translate(\${drift}px, \${fallDistance}px) rotate(\${rotate}deg)\`;
        }, delay);
      });
    });

    showToast('🪂 重力発生！', false);

    // アニメーション完了後、再入力できるようにする（再描画やリロードでも自然にリセットされる）
    setTimeout(() => { triggered = false; }, maxDuration + 300);
  }

  document.addEventListener('keydown', e => {
    if (isAnyOverlayOpen()) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const dir = map[e.key];
    if (!dir) return;
    feedInput(dir);
  });

  // スワイプでのコナミコード入力（上下左右ジェスチャー）
  (function() {
    let sx = 0, sy = 0;
    const SWIPE_MIN = 35;

    document.addEventListener('touchstart', e => {
      if (isAnyOverlayOpen()) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', e => {
      if (isAnyOverlayOpen()) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < SWIPE_MIN) return;

      let dir;
      if (adx > ady) dir = dx > 0 ? 'right' : 'left';
      else dir = dy > 0 ? 'down' : 'up';

      feedInput(dir);
    }, { passive: true });
  })();
})();

// ===== チップのドラッグ =====
let _ghost = null;
function setupChipDrag(chip, subj) {
  chip.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', subj);
    chip.classList.add('dragging');
  });
  chip.addEventListener('dragend', () => chip.classList.remove('dragging'));

  chip.addEventListener('touchstart', e => {
    const t = e.touches[0];
    _ghost = document.createElement('div');
    _ghost.className = 'chip-ghost';
    _ghost.textContent = subj;
    _ghost.style.background = stringToColor(subj);
    _ghost.style.left = t.clientX + 'px';
    _ghost.style.top = t.clientY + 'px';
    document.body.appendChild(_ghost);
    chip.classList.add('dragging');
  }, { passive: true });

  chip.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    if (_ghost) { _ghost.style.left = t.clientX + 'px'; _ghost.style.top = t.clientY + 'px'; }
    document.querySelectorAll('.period-row').forEach(row => row.classList.remove('drag-over'));
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const row = el && el.closest('.period-row');
    if (row) row.classList.add('drag-over');
  }, { passive: false });

  chip.addEventListener('touchend', e => {
    chip.classList.remove('dragging');
    if (_ghost) { _ghost.remove(); _ghost = null; }
    const t = e.changedTouches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const row = el && el.closest('.period-row');
    if (row) {
      row.classList.remove('drag-over');
      const inp = row.querySelector('input');
      if (inp) { inp.value = subj; updateInputStyle(inp); }
    }
  }, { passive: true });
}

// ===== CAMERA =====
async function openCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    const video = document.getElementById('cameraVideo');
    video.srcObject = cameraStream;
    document.getElementById('cameraOverlay').classList.add('active');
  } catch(e) {
    await showDialog({
      icon: '📷',
      title: 'カメラにアクセスできません',
      message: 'ブラウザの設定からカメラの使用を許可してください。',
      buttons: [{ label: '閉じる', style: 'primary', value: 'ok' }]
    });
  }
}
function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  document.getElementById('cameraOverlay').classList.remove('active');
}
async function capturePhoto() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('captureCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  closeCamera();
  document.getElementById('processingOverlay').classList.add('active');

  try {
    const imageData = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    const result = await analyzeWithClaude(imageData);
    document.getElementById('processingOverlay').classList.remove('active');
    showConfirmModal(result);
  } catch(e) {
    document.getElementById('processingOverlay').classList.remove('active');
    await showDialog({
      icon: '❌',
      title: '読み取りに失敗しました',
      message: e.message || 'もう一度お試しください。',
      buttons: [
        { label: '撮り直す', style: 'primary', value: 'retry' },
        { label: '閉じる', style: 'secondary', value: 'close' }
      ]
    });
    // 撮り直すを選んだ場合
    if (arguments[0] === 'retry') openCamera();
  }
}

async function analyzeWithClaude(base64Image) {
  const res = await fetch(\`/api/scan?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,' + base64Image })
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    const msg = data.error === 'parse_failed'
      ? \`読み取り結果の解析に失敗しました。\\n（生テキスト: \${(data.raw || '').slice(0, 120)}）\`
      : (data.error || \`サーバーエラー: \${res.status}\`);
    throw new Error(msg);
  }

  return data.periods;
}

// ===== SCAN CONFIRM =====
function showConfirmModal(periods) {
  scannedPeriods = periods;
  const list = document.getElementById('confirmList');
  list.innerHTML = '';

  for (let i = 1; i <= PERIODS; i++) {
    const subject = periods[String(i)] || periods[i] || '';
    const li = document.createElement('li');
    li.className = 'confirm-item';
    li.innerHTML = \`
      <span class="confirm-period">\${i}限</span>
      \${subject
        ? \`<span class="confirm-subject" style="background:\${stringToColor(subject)};padding:4px 10px;border-radius:8px">\${subject}</span>\`
        : \`<span class="confirm-empty">Empty</span>\`
      }
    \`;
    list.appendChild(li);
  }
  document.getElementById('confirmOverlay').classList.add('active');
}
function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('active');
  openCamera();
}
function applyScannedData() {
  document.getElementById('confirmOverlay').classList.remove('active');
  for (let i = 1; i <= PERIODS; i++) {
    const inp = document.getElementById(\`p-\${i}\`);
    if (inp) {
      const val = scannedPeriods[String(i)] || scannedPeriods[i] || '';
      inp.value = val;
      updateInputStyle(inp);
    }
  }
}

// ===== 未読管理 =====
const READ_KEY = \`board_read_\${CALENDAR_ID}\`;
function getLastReadTime() {
  try { return parseInt(localStorage.getItem(READ_KEY) || '0', 10); } catch(e) { return 0; }
}
function markAllRead() {
  try { localStorage.setItem(READ_KEY, String(Date.now())); } catch(e) {}
}
function countUnread(images) {
  const lastRead = getLastReadTime();
  return images.filter(img => img.uploadedAt > lastRead).length;
}

// ===== 掲示板 =====
async function openBoard() {
  document.getElementById('boardOverlay').classList.add('active');
  await loadBoardImages();
}
function closeBoard() {
  markAllRead();
  updateBoardBadge();
  document.getElementById('boardOverlay').classList.remove('active');
}

async function loadBoardImages() {
  try {
    const res = await fetch(\`/api/images?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
    if (res.ok) {
      boardImages = await res.json();
      renderBoardImages();
      updateBoardBadge(true);
      updateCapacityBar();
    }
  } catch(e) { console.error(e); }
}

function getFileIcon(img) {
  const t = img.fileType || '';
  const n = (img.fileName || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return '📄';
  if (t.includes('word') || n.endsWith('.doc') || n.endsWith('.docx')) return '📝';
  if (t.includes('excel') || n.endsWith('.xls') || n.endsWith('.xlsx')) return '📊';
  if (t === 'text/plain' || n.endsWith('.txt')) return '🗒️';
  return null;
}

function renderBoardImages() {
  const gridEl = document.getElementById('imagesGrid');
  if (!boardImages || boardImages.length === 0) {
    gridEl.innerHTML = \`<div class="board-empty" style="grid-column:1/-1"><div class="board-empty-icon">📭</div>まだファイルがありません${canEdit ? '<br><small style="margin-top:8px;display:block">上のエリアから追加できます</small>' : ''}</div>\`;
    return;
  }
  const lastRead = getLastReadTime();
  gridEl.innerHTML = '';
  boardImages.forEach(img => {
    const isNew = img.uploadedAt > lastRead;
    const card = document.createElement('div');
    card.className = 'image-card';
    const date = new Date(img.uploadedAt);
    const dateStr = \`\${date.getMonth()+1}/\${date.getDate()}\`;
    const icon = getFileIcon(img);

    const thumb = icon
      ? \`<div class="file-thumb" onclick="openFullscreen('\${img.id}')" style="cursor:pointer">
           <div class="file-thumb-icon">\${icon}</div>
           <div class="file-thumb-name">\${img.fileName || img.name || 'ファイル'}</div>
         </div>\`
      : \`<img src="\${img.dataUrl}" alt="\${img.name || '画像'}" onclick="openFullscreen('\${img.id}')">\`;

    card.innerHTML = \`
      \${thumb}
      <div class="image-card-footer">
        \${isNew ? '<span class="img-new-badge">NEW</span>' : ''}
        <span class="image-name">\${img.name || dateStr}</span>
        ${canEdit ? `<button class="image-delete-btn" onclick="confirmDeleteImage(event, '\${img.id}')" title="削除">🗑</button>` : ''}
      </div>
    \`;
    gridEl.appendChild(card);
  });
}

function updateBoardBadge(isOpen = false) {
  const badge = document.getElementById('boardBadge');
  if (isOpen) { badge.classList.remove('visible'); return; }
  const unread = countUnread(boardImages);
  if (unread > 0) { badge.textContent = unread; badge.classList.add('visible'); }
  else badge.classList.remove('visible');
}

function updateCapacityBar() {
  const bar = document.getElementById('boardCapacityBar');
  const capText = document.getElementById('capText');
  const capRemain = document.getElementById('capRemain');
  const fill = document.getElementById('capBarFill');
  if (!bar) return;
  const count = boardImages.length;
  const remain = BOARD_LIMIT - count;
  bar.style.display = 'block';
  capText.textContent = \`\${count} / \${BOARD_LIMIT}\`;
  capRemain.textContent = \`残り: \${remain}\`;
  const pct = Math.min(100, (count / BOARD_LIMIT) * 100);
  fill.style.width = pct + '%';
  fill.classList.toggle('warn', pct >= 80);
}

const BOARD_LIMIT = 50;

async function handleFileSelect(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;

  for (const file of files) {
    if (boardImages.length >= BOARD_LIMIT) {
      showToast(\`⚠️ 上限\${BOARD_LIMIT}件に達しています\`, true);
      break;
    }
    showToast('アップロード中...');
    try {
      let dataUrl = await readFileAsDataURL(file);
      if (file.type.startsWith('image/')) dataUrl = await resizeImage(dataUrl, 1200);
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
      const res = await fetch(\`/api/images?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, dataUrl, fileType: file.type, fileName: file.name })
      });
      if (res.ok) {
        showToast('✓ 追加しました');
      } else if (res.status === 400) {
        showToast(\`⚠️ 上限\${BOARD_LIMIT}件に達しています\`, true);
        break;
      } else {
        showToast('⚠️ 追加エラー', true);
      }
    } catch(e) {
      showToast('⚠️ エラー: ' + e.message, true);
    }
  }
  event.target.value = '';
  await loadBoardImages();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resizeImage(dataUrl, maxWidth) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataUrl;
  });
}

// 削除確認（カスタムダイアログ）
async function confirmDeleteImage(event, imgId) {
  event.stopPropagation();
  const result = await showDialog({
    icon: '🗑️',
    title: 'ファイルを削除しますか？',
    message: 'この操作は元に戻せません。',
    buttons: [
      { label: 'キャンセル', style: 'secondary', value: 'cancel' },
      { label: '削除する', style: 'danger', value: 'delete' }
    ]
  });
  if (result !== 'delete') return;
  try {
    const res = await fetch(\`/api/images?id=\${CALENDAR_ID}&pass=\${PASSWORD}&imgId=\${imgId}\`, {
      method: 'DELETE'
    });
    if (res.ok) {
      showToast('✓ 削除しました');
      await loadBoardImages();
    } else {
      showToast('⚠️ 削除エラー', true);
    }
  } catch(e) {
    showToast('⚠️ エラー', true);
  }
}

function openFullscreen(imgId) {
  const img = boardImages.find(i => i.id === imgId);
  if (!img) return;
  const icon = getFileIcon(img);
  if (icon) {
    const win = window.open();
    if (img.fileType === 'text/plain' || (img.fileName || '').endsWith('.txt')) {
      const text = atob(img.dataUrl.split(',')[1]);
      win.document.write('<pre style="white-space:pre-wrap;font-family:sans-serif;padding:20px">' + text.replace(/</g,'&lt;') + '</pre>');
    } else {
      win.location = img.dataUrl;
    }
    return;
  }
  document.getElementById('fullscreenImg').src = img.dataUrl;
  document.getElementById('imgFullscreen').classList.add('active');
}
function closeFullscreen() {
  document.getElementById('imgFullscreen').classList.remove('active');
}

// ===== チャット =====
const CHAT_PROFILE_KEY = \`chat_profile_\${CALENDAR_ID}\`;
const CHAT_READ_KEY = \`chat_read_\${CALENDAR_ID}\`;
const CHAT_LAST_TS_KEY = \`chat_last_ts_\${CALENDAR_ID}\`;

function chatEscapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// テキストをエスケープしつつURLをリンク化
function linkifyText(text) {
  const escaped = chatEscapeHtml(text);
  const urlPattern = /(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)'"\\]])/g;
  return escaped.replace(urlPattern, url => \`<a href="\${url}" target="_blank" rel="noopener noreferrer">\${url}</a>\`);
}

// サーバー側のnormalizeChatNameと同じ正規化ロジック(自分のuserKey特定に使用)
function normalizeChatNameClient(name) {
  return (name || '').trim().toLowerCase();
}

function loadChatProfile() {
  if (DISCORD_LOGGED_IN) {
    return { name: DISCORD_NAME, avatar: DISCORD_AVATAR, clientId: null, isDiscord: true };
  }
  try {
    const raw = localStorage.getItem(CHAT_PROFILE_KEY);
    if (raw) {
      const profile = JSON.parse(raw);
      // 旧バージョン(パスワード認証なし)のプロフィールは無効化し、再ログインを促す
      if (!profile.authToken) return null;
      return profile;
    }
  } catch(e) {}
  return null;
}

function saveLocalChatProfile(profile) {
  try { localStorage.setItem(CHAT_PROFILE_KEY, JSON.stringify(profile)); } catch(e) {}
}
function clearLocalChatProfile() {
  try { localStorage.removeItem(CHAT_PROFILE_KEY); } catch(e) {}
}

function getLastChatReadTime() {
  try { return parseInt(localStorage.getItem(CHAT_READ_KEY) || '0', 10); } catch(e) { return 0; }
}
function markChatRead() {
  try { localStorage.setItem(CHAT_READ_KEY, String(Date.now())); } catch(e) {}
}
function getLastChatTs() {
  try { return parseInt(localStorage.getItem(CHAT_LAST_TS_KEY) || '0', 10); } catch(e) { return 0; }
}
function setLastChatTs(ts) {
  try { localStorage.setItem(CHAT_LAST_TS_KEY, String(ts)); } catch(e) {}
}

async function openChat() {
  if (EDIT_MODE === 'discord' && !DISCORD_LOGGED_IN) {
    const result = await showDialog({
      icon: '🔒',
      title: 'ログインが必要です',
      message: 'このカレンダーのチャットはDiscordでログインした人のみ利用できます。',
      buttons: [
        { label: '閉じる', style: 'secondary', value: 'cancel' },
        { label: 'ログイン', style: 'primary', value: 'login' }
      ]
    });
    if (result === 'login') {
      location.href = '/auth/login?state=' + encodeURIComponent(location.pathname + location.search);
    }
    return;
  }
  chatProfile = loadChatProfile();
  if (!chatProfile) {
    openProfileSetup();
    return;
  }
  document.getElementById('chatLogoutBtn').style.display = chatProfile.isDiscord ? 'none' : '';
  document.getElementById('chatOverlay').classList.add('active');
  await loadChatMessages(true);
  markChatRead();
  updateChatBadge();
  hideChatNewBanner();
  scrollChatToBottom();
  startChatPolling();
}

function logoutChatAccount() {
  clearLocalChatProfile();
  chatProfile = null;
  closeChat();
  openProfileSetup();
}

function closeChat() {
  document.getElementById('chatOverlay').classList.remove('active');
  markChatRead();
  updateChatBadge();
  hideChatNewBanner();
  stopChatPolling();
}

function startChatPolling() {
  stopChatPolling();
  chatPollTimer = setInterval(() => loadChatMessages(false), 4000);
  bindChatScrollListener();
}
function stopChatPolling() {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
}

let _chatScrollBound = false;
function bindChatScrollListener() {
  if (_chatScrollBound) return;
  const body = document.getElementById('chatBody');
  if (!body) return;
  body.addEventListener('scroll', onChatBodyScroll, { passive: true });
  _chatScrollBound = true;
}

async function loadChatMessages(full) {
  try {
    const since = full ? 0 : getLastChatTs();
    const res = await fetch(\`/api/chat?id=\${CALENDAR_ID}&pass=\${PASSWORD}&since=\${full ? 0 : since}\`);
    if (!res.ok) return;
    const data = await res.json();
    const overlayActive = document.getElementById('chatOverlay').classList.contains('active');
    // 新規メッセージ受信前に、現在ユーザーが下端付近を見ているかを判定しておく
    const wasNearBottom = !overlayActive || isChatNearBottom();
    if (full) {
      chatMessages = data;
    } else if (data.length) {
      chatMessages = chatMessages.concat(data);
    }
    if (data.length) setLastChatTs(data[data.length - 1].ts);
    renderChatMessages();
    if (overlayActive) {
      if (full || wasNearBottom) {
        // 初回読み込み、または既に最新メッセージ付近を見ていた場合のみ追従する
        markChatRead();
        hideChatNewBanner();
        scrollChatToBottom();
      } else if (data.length) {
        // 過去ログを見ている最中に新着があった場合はスクロールせずバナーで知らせる
        showChatNewBanner(data.length);
      }
    }
    updateChatBadge();
  } catch(e) { console.error(e); }
}

// チャット欄の下端付近(閾値80px以内)を見ているかどうかを判定
function isChatNearBottom() {
  const body = document.getElementById('chatBody');
  if (!body) return true;
  return (body.scrollHeight - body.scrollTop - body.clientHeight) < 80;
}

let chatNewCount = 0;
function showChatNewBanner(addCount) {
  chatNewCount += addCount || 0;
  const banner = document.getElementById('chatNewBanner');
  const text = document.getElementById('chatNewBannerText');
  if (!banner || !text) return;
  text.textContent = chatNewCount > 0 ? \`\${chatNewCount}件の新しいメッセージ\` : '新しいメッセージ';
  banner.classList.add('visible');
}
function hideChatNewBanner() {
  chatNewCount = 0;
  const banner = document.getElementById('chatNewBanner');
  if (banner) banner.classList.remove('visible');
}
function jumpToLatestChat() {
  markChatRead();
  hideChatNewBanner();
  scrollChatToBottom();
  updateChatBadge();
}
// ユーザーが自力でスクロールして下端に到達した場合もバナーを消して既読にする
function onChatBodyScroll() {
  if (chatNewCount > 0 && isChatNearBottom()) {
    markChatRead();
    hideChatNewBanner();
    updateChatBadge();
  }
}

function renderChatMessages() {
  const body = document.getElementById('chatMessagesList');
  if (!chatMessages || chatMessages.length === 0) {
    body.innerHTML = \`<div class="chat-empty"><div class="chat-empty-icon">💬</div>まだメッセージがありません<br><small style="margin-top:6px;display:block">最初のメッセージを送ってみましょう</small></div>\`;
    return;
  }
  const myKey = chatProfile ? (chatProfile.isDiscord ? \`discord:\${DISCORD_ID}\` : \`guest:\${normalizeChatNameClient(chatProfile.name)}\`) : null;
  body.innerHTML = '';
  chatMessages.forEach(msg => {
    const isOwn = myKey && msg.userKey === myKey;
    const row = document.createElement('div');
    row.className = 'chat-msg' + (isOwn ? ' own' : '');
    const avatarHtml = msg.avatar
      ? \`<img class="chat-msg-avatar" src="\${msg.avatar}" alt="">\`
      : \`<div class="chat-msg-avatar" style="display:flex;align-items:center;justify-content:center;font-size:0.9rem;font-weight:700;color:var(--text-sub)">\${(msg.name||'?').charAt(0).toUpperCase()}</div>\`;
    const date = new Date(msg.ts);
    const timeStr = \`\${String(date.getHours()).padStart(2,'0')}:\${String(date.getMinutes()).padStart(2,'0')}\`;
    let bodyHtml = '';
    if (msg.text) bodyHtml += \`<div class="chat-msg-bubble">\${linkifyText(msg.text)}</div>\`;
    if (msg.image) bodyHtml += \`<div class="chat-msg-bubble" style="padding:6px"><img class="chat-msg-img" src="\${msg.image}" onclick="openChatImageFullscreen('\${msg.id}')"></div>\`;
    row.innerHTML = \`
      \${avatarHtml}
      <div class="chat-msg-body">
        <span class="chat-msg-name">\${chatEscapeHtml(msg.name || 'ゲスト')}</span>
        \${bodyHtml}
        <span class="chat-msg-time">\${timeStr}</span>
      </div>
    \`;
    body.appendChild(row);
  });
}

function openChatImageFullscreen(msgId) {
  const msg = chatMessages.find(m => m.id === msgId);
  if (!msg || !msg.image) return;
  document.getElementById('fullscreenImg').src = msg.image;
  document.getElementById('imgFullscreen').classList.add('active');
}

function scrollChatToBottom() {
  const body = document.getElementById('chatBody');
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

function updateChatBadge() {
  const badge = document.getElementById('chatBadge');
  const overlayActive = document.getElementById('chatOverlay').classList.contains('active');
  if (overlayActive) { badge.classList.remove('visible'); return; }
  const lastRead = getLastChatReadTime();
  const unread = chatMessages.filter(m => m.ts > lastRead).length;
  if (unread > 0) { badge.textContent = unread > 99 ? '99+' : unread; badge.classList.add('visible'); }
  else badge.classList.remove('visible');
}

function autoGrowChatInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(100, el.scrollHeight) + 'px';
}

function handleChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

async function handleChatImageSelect(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    let dataUrl = await readFileAsDataURL(file);
    dataUrl = await resizeImage(dataUrl, 1000);
    chatAttachmentDataUrl = dataUrl;
    document.getElementById('chatPreviewImg').src = dataUrl;
    document.getElementById('chatPreviewBar').classList.add('visible');
  } catch(e) {
    showToast('⚠️ 画像の読み込みに失敗しました', true);
  }
}

function removeChatAttachment() {
  chatAttachmentDataUrl = null;
  document.getElementById('chatPreviewBar').classList.remove('visible');
}

async function sendChatMessage() {
  const input = document.getElementById('chatTextInput');
  const text = input.value.trim();
  const image = chatAttachmentDataUrl;
  if (text === '/dinnerbone') {
    input.value = '';
    autoGrowChatInput(input);
    toggleDinnerbone();
    return;
  }
  if (!text && !image) return;
  if (EDIT_MODE === 'discord' && !DISCORD_LOGGED_IN) {
    showToast('⚠️ ログインが必要です', true);
    return;
  }

  const sendBtn = document.getElementById('chatSendBtn');
  sendBtn.disabled = true;
  try {
    const payload = { text, image };
    if (!chatProfile.isDiscord) {
      payload.name = chatProfile.name;
      payload.avatar = chatProfile.avatar || '';
      payload.authToken = chatProfile.authToken;
    }
    const res = await fetch(\`/api/chat?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      input.value = '';
      autoGrowChatInput(input);
      removeChatAttachment();
      await loadChatMessages(false);
      markChatRead();
      scrollChatToBottom();
    } else if (res.status === 401) {
      const err = await res.json().catch(() => ({}));
      if (err.error === 'auth_invalid' || err.error === 'auth_required') {
        handleChatAuthInvalid();
      } else {
        showToast('⚠️ ログインが必要です', true);
      }
    } else {
      showToast('⚠️ 送信エラー', true);
    }
  } catch(e) {
    showToast('⚠️ 送信エラー', true);
  } finally {
    sendBtn.disabled = false;
  }
}

// ===== プロフィール設定(初回 / ログイン・新規登録) =====
let profileIconDataUrl = null;
let authMode = 'register'; // 'register' | 'login'

function openProfileSetup() {
  if (DISCORD_LOGGED_IN) {
    // Discordログイン済みなら自動的にプロフィール確定してチャットを開く
    chatProfile = { name: DISCORD_NAME, avatar: DISCORD_AVATAR, clientId: null, isDiscord: true };
    openChat();
    return;
  }
  document.getElementById('profileNameInput').value = '';
  document.getElementById('profilePasswordInput').value = '';
  document.getElementById('profileAuthError').textContent = '';
  profileIconDataUrl = null;
  document.getElementById('profileIconPlaceholder').style.display = '';
  const preview = document.getElementById('profileIconPreview');
  const existingImg = preview.querySelector('img');
  if (existingImg) existingImg.remove();
  switchAuthMode('register');
  document.getElementById('profileOverlay').classList.add('active');
}

function closeProfileSetup() {
  document.getElementById('profileOverlay').classList.remove('active');
}

function switchAuthMode(mode) {
  authMode = mode;
  document.getElementById('authTabRegister').classList.toggle('active', mode === 'register');
  document.getElementById('authTabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('profileSaveBtn').textContent = mode === 'register' ? '登録してチャットを始める' : 'ログインしてチャットを始める';
  document.getElementById('profileAuthError').textContent = '';
}

async function handleProfileIconSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    let dataUrl = await readFileAsDataURL(file);
    dataUrl = await resizeImage(dataUrl, 200);
    profileIconDataUrl = dataUrl;
    const preview = document.getElementById('profileIconPreview');
    document.getElementById('profileIconPlaceholder').style.display = 'none';
    let img = preview.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      preview.appendChild(img);
    }
    img.src = dataUrl;
  } catch(e) {
    showToast('⚠️ 画像の読み込みに失敗しました', true);
  }
}

async function saveProfileSetup() {
  const name = document.getElementById('profileNameInput').value.trim().slice(0, 20);
  const password = document.getElementById('profilePasswordInput').value;
  const errorEl = document.getElementById('profileAuthError');
  const btn = document.getElementById('profileSaveBtn');
  errorEl.textContent = '';

  if (!name) {
    errorEl.textContent = '表示名を入力してください';
    return;
  }
  if (!password || password.length < 4) {
    errorEl.textContent = 'パスワードは4文字以上で入力してください';
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(\`/api/chat-auth?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: authMode,
        name,
        password,
        avatar: profileIconDataUrl || ''
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      errorEl.textContent = authErrorMessage(data.error);
      btn.disabled = false;
      return;
    }
    const profile = {
      name: data.name,
      avatar: authMode === 'register' ? (profileIconDataUrl || '') : (data.avatar || ''),
      authToken: data.authToken,
      isDiscord: false
    };
    saveLocalChatProfile(profile);
    chatProfile = profile;
    btn.disabled = false;
    closeProfileSetup();
    openChat();
  } catch(e) {
    errorEl.textContent = '通信エラーが発生しました。もう一度お試しください';
    btn.disabled = false;
  }
}

function authErrorMessage(code) {
  switch(code) {
    case 'name_taken': return 'この表示名は既に使われています';
    case 'not_found': return 'そのアカウントは見つかりません（新規登録が必要です）';
    case 'wrong_password': return 'パスワードが間違っています';
    case 'password_too_short': return 'パスワードは4文字以上で入力してください';
    case 'name_required': return '表示名を入力してください';
    default: return 'エラーが発生しました。もう一度お試しください';
  }
}

// 認証エラー(トークン無効化など)が起きた際、ローカルのプロフィールを破棄してログイン画面に戻す
function handleChatAuthInvalid() {
  clearLocalChatProfile();
  chatProfile = null;
  showToast('⚠️ ログインの有効期限が切れました。再度ログインしてください', true);
  closeChat();
  openProfileSetup();
}

// ===== アプリ内通知トースト =====
let _notifTimer = null;
let _notifTarget = null; // 'chat' | 'board'

function showNotifToast(icon, text, target) {
  _notifTarget = target;
  document.getElementById('notifIcon').textContent = icon;
  document.getElementById('notifText').textContent = text;
  const toast = document.getElementById('notifToast');
  toast.classList.add('visible');
  clearTimeout(_notifTimer);
  _notifTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

function handleNotifClick() {
  document.getElementById('notifToast').classList.remove('visible');
  if (_notifTarget === 'chat') openChat();
  else if (_notifTarget === 'board') openBoard();
}

// ===== バックグラウンドポーリング =====
let _bgBoardTimer = null;
let _bgChatTimer = null;
let _bgScheduleTimer = null;

async function bgPollBoard() {
  try {
    const res = await fetch(\`/api/images?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
    if (!res.ok) return;
    const newImages = await res.json();
    const prevIds = new Set(boardImages.map(i => i.id));
    const added = newImages.filter(i => !prevIds.has(i.id));
    boardImages = newImages;
    const boardOpen = document.getElementById('boardOverlay').classList.contains('active');
    if (boardOpen) {
      renderBoardImages();
      updateCapacityBar();
      updateBoardBadge(true);
    } else {
      updateBoardBadge();
      if (added.length > 0) {
        const firstName = added[0].name || added[0].fileName || '新しいファイル';
        const msg = added.length === 1
          ? \`📎 \${firstName}\`
          : \`📎 \${added.length}件の新しいファイルが追加されました\`;
        showNotifToast('🗒️', msg, 'board');
      }
    }
  } catch(e) {}
}

async function bgPollChat() {
  // チャットが開いている間は startChatPolling が担当するのでスキップ
  if (document.getElementById('chatOverlay').classList.contains('active')) return;
  try {
    const since = getLastChatTs();
    const res = await fetch(\`/api/chat?id=\${CALENDAR_ID}&pass=\${PASSWORD}&since=\${since}\`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.length) return;
    const chatOpen = document.getElementById('chatOverlay').classList.contains('active');
    const myKey = chatProfile ? (chatProfile.isDiscord ? \`discord:\${DISCORD_ID}\` : \`guest:\${normalizeChatNameClient(chatProfile.name)}\`) : null;
    const incoming = myKey ? data.filter(m => m.userKey !== myKey) : data;
    chatMessages = chatMessages.concat(data);
    setLastChatTs(data[data.length - 1].ts);
    if (chatOpen) {
      renderChatMessages();
      markChatRead();
      scrollChatToBottom();
    } else {
      updateChatBadge();
      if (incoming.length > 0) {
        const last = incoming[incoming.length - 1];
        const preview = last.text
          ? last.text.slice(0, 40) + (last.text.length > 40 ? '…' : '')
          : '📷 画像';
        showNotifToast('💬', \`\${last.name || 'ゲスト'}: \${preview}\`, 'chat');
      }
    }
  } catch(e) {}
}

function startBgPolling() {
  if (_bgBoardTimer) clearInterval(_bgBoardTimer);
  if (_bgChatTimer) clearInterval(_bgChatTimer);
  if (_bgScheduleTimer) clearInterval(_bgScheduleTimer);
  _bgBoardTimer = setInterval(bgPollBoard, 15000);
  _bgChatTimer  = setInterval(bgPollChat,  8000);
  _bgScheduleTimer = setInterval(bgPollSchedule, 10000);
}

// ===== ANDROID APP BANNER =====
const ANDROID_APP_DISMISS_KEY = 'androidAppBannerDismissed';
function dismissAndroidAppBanner() {
  const el = document.getElementById('androidAppBanner');
  if (el) el.classList.remove('show');
  try { localStorage.setItem(ANDROID_APP_DISMISS_KEY, '1'); } catch(e) {}
}
function initAndroidAppBanner() {
  try {
    const isAndroid = /Android/i.test(navigator.userAgent);
    const dismissed = localStorage.getItem(ANDROID_APP_DISMISS_KEY) === '1';
    if (isAndroid && !dismissed) {
      const el = document.getElementById('androidAppBanner');
      if (el) el.classList.add('show');
    }
  } catch(e) {}
}
initAndroidAppBanner();

// ===== 隠し要素: dinnerbone (サイト反転) =====
const DINNERBONE_KEY = 'dinnerboneMode';
function setDinnerbone(on) {
  document.body.classList.toggle('dinnerbone-mode', on);
  try { localStorage.setItem(DINNERBONE_KEY, on ? '1' : '0'); } catch(e) {}
}
function toggleDinnerbone() {
  setDinnerbone(!document.body.classList.contains('dinnerbone-mode'));
}
function initDinnerbone() {
  try {
    const urlHasIt = location.search.toLowerCase().includes('dinnerbone');
    const savedOn = localStorage.getItem(DINNERBONE_KEY) === '1';
    if (urlHasIt) {
      setDinnerbone(true);
    } else if (savedOn) {
      setDinnerbone(true);
    }
  } catch(e) {}
}
initDinnerbone();

// ===== INIT =====
loadData();
(async () => {
  try {
    const res = await fetch(\`/api/images?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
    if (res.ok) { boardImages = await res.json(); updateBoardBadge(); }
  } catch(e) {}
})();
(async () => {
  try {
    const res = await fetch(\`/api/chat?id=\${CALENDAR_ID}&pass=\${PASSWORD}\`);
    if (res.ok) {
      chatMessages = await res.json();
      if (chatMessages.length) setLastChatTs(chatMessages[chatMessages.length - 1].ts);
      updateChatBadge();
    }
  } catch(e) {}
  startBgPolling();
})();
</script>

</body>
</html>`, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  }
};

// ===== セッションの署名(HMAC-SHA256) =====
// 以前は session Cookie が単純な Base64(JSON) で、署名検証が無かったため、
// 誰でも任意の Discord ID を名乗ったセッションを偽造できてしまっていた。
// SESSION_SECRET (wrangler secret) を使い、Cookie に署名を付けて偽造を防ぐ。
//   wrangler secret put SESSION_SECRET
async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufToHex(sig);
}

async function createSessionCookie(env, payload) {
  const body = btoa(JSON.stringify(payload));
  if (!env.SESSION_SECRET) return body; // SESSION_SECRET未設定時は旧方式にフォールバック(署名なし)
  const sig = await hmacSign(env.SESSION_SECRET, body);
  return `${body}.${sig}`;
}

async function getSession(req, env) {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  try {
    const raw = match[1];
    let body = raw;
    if (env && env.SESSION_SECRET) {
      const dotIdx = raw.lastIndexOf(".");
      if (dotIdx === -1) return null; // 署名必須なのに署名が無い→偽造または旧Cookie
      body = raw.slice(0, dotIdx);
      const sig = raw.slice(dotIdx + 1);
      const expectedSig = await hmacSign(env.SESSION_SECRET, body);
      if (sig !== expectedSig) return null; // 署名不一致→偽造の可能性
    }
    const data = JSON.parse(atob(body));
    if (Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

// ===== チャットゲストアカウント用パスワードハッシュ (Web Crypto / SHA-256 + salt) =====
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToHex(arr);
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder().encode(salt + ":" + password);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return bufToHex(digest);
}
function normalizeChatName(name) {
  return (name || "").trim().toLowerCase();
}

// ===== R2への定期バックアップ =====
// KV上の全カレンダーデータ (META / DATA / DATA_VER / IMAGES / CHAT / CHATUSER) を
// 1つのJSONにまとめて R2 に保存する。
// 保存パス: YYYYMMDD/calendartimetable/data.json  (例: 20260623/calendartimetable/data.json)
function backupDateKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function collectAllCalendarData(kv) {
  const calendars = {};

  // META_ プレフィックスで全カレンダーIDを列挙
  let cursor;
  const metaKeys = [];
  do {
    const listed = await kv.list({ prefix: "META_", cursor });
    for (const k of listed.keys) metaKeys.push(k.name);
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  for (const metaKeyName of metaKeys) {
    const id = metaKeyName.slice("META_".length);
    const meta = await kv.get(metaKeyName, { type: "json" });
    const data = await kv.get(`DATA_${id}`, { type: "json" }).catch(() => null);
    const ver = await kv.get(`DATA_VER_${id}`);
    const images = await kv.get(`IMAGES_${id}`, { type: "json" }).catch(() => null);
    const chat = await kv.get(`CHAT_${id}`, { type: "json" }).catch(() => null);

    // CHATUSER_<id>_* はユーザー名を知らないと直接getできないため、prefixでlistして収集
    const chatUsers = {};
    let cuCursor;
    do {
      const listed = await kv.list({ prefix: `CHATUSER_${id}_`, cursor: cuCursor });
      for (const k of listed.keys) {
        const account = await kv.get(k.name, { type: "json" }).catch(() => null);
        if (account) chatUsers[k.name] = account;
      }
      cuCursor = listed.list_complete ? undefined : listed.cursor;
    } while (cuCursor);

    calendars[id] = {
      meta: meta || null,
      data: data || null,
      ver: ver || null,
      images: images || null,
      chat: chat || null,
      chatUsers,
    };
  }

  return calendars;
}

async function runBackup(env) {
  if (!env.CALENDAR_KV) throw new Error("CALENDAR_KV binding missing");
  if (!env.BACKUP_BUCKET) throw new Error("BACKUP_BUCKET (R2) binding missing");

  const calendars = await collectAllCalendarData(env.CALENDAR_KV);
  const payload = {
    backedUpAt: new Date().toISOString(),
    calendarCount: Object.keys(calendars).length,
    calendars,
  };

  const dateKey = backupDateKey();
  const objectKey = `${dateKey}/calendartimetable/data.json`;

  await env.BACKUP_BUCKET.put(objectKey, JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json" },
  });

  return { ok: true, objectKey, calendarCount: payload.calendarCount, backedUpAt: payload.backedUpAt };
}

// ===== R2高額請求防止策 =====
// カレンダー更新のたびに無条件でバックアップを走らせると、編集が集中した時に
// R2への書き込み(Class A操作)が急増し、想定外の課金につながる恐れがある。
// そのため以下の二重の安全策を設ける:
//   1. クールダウン: 直近のバックアップから一定時間(デフォルト30分)経っていない場合はスキップ
//   2. 日次上限: 1日あたりの最大バックアップ回数(デフォルト50回)を超えたらスキップ
// どちらの値も wrangler.toml の [vars] で BACKUP_COOLDOWN_MINUTES / BACKUP_MAX_PER_DAY
// として上書きできる。なお同じ日のバックアップは同一オブジェクトキーを上書きするだけなので、
// ストレージ容量が膨らむことはなく、増えるのは書き込み回数(課金対象)のみ。
const BACKUP_LOCK_KEY = "BACKUP_LAST_RUN_TS";
const BACKUP_COUNT_KEY_PREFIX = "BACKUP_COUNT_";

async function triggerBackup(env, ctx, reason) {
  if (!env.CALENDAR_KV) return { ok: false, skipped: true, reason: "CALENDAR_KV binding missing" };
  if (!env.BACKUP_BUCKET) return { ok: false, skipped: true, reason: "BACKUP_BUCKET binding missing" };

  const cooldownMinutes = Number(env.BACKUP_COOLDOWN_MINUTES) > 0 ? Number(env.BACKUP_COOLDOWN_MINUTES) : 30;
  const maxPerDay = Number(env.BACKUP_MAX_PER_DAY) > 0 ? Number(env.BACKUP_MAX_PER_DAY) : 50;

  const now = Date.now();

  // 1. クールダウンチェック
  const lastRunStr = await env.CALENDAR_KV.get(BACKUP_LOCK_KEY);
  const lastRun = lastRunStr ? Number(lastRunStr) : 0;
  if (now - lastRun < cooldownMinutes * 60 * 1000) {
    return { ok: false, skipped: true, reason: "cooldown", reason_detail: `次のバックアップまで残り約${Math.ceil((cooldownMinutes * 60 * 1000 - (now - lastRun)) / 60000)}分`, trigger: reason };
  }

  // 2. 日次上限チェック
  const dateKey = backupDateKey();
  const countKey = `${BACKUP_COUNT_KEY_PREFIX}${dateKey}`;
  const countStr = await env.CALENDAR_KV.get(countKey);
  const count = countStr ? Number(countStr) : 0;
  if (count >= maxPerDay) {
    return { ok: false, skipped: true, reason: "daily-cap", trigger: reason, count, maxPerDay };
  }

  // ロックを先に更新してから実行(同時アクセスによる多重実行をできるだけ防ぐ)
  await env.CALENDAR_KV.put(BACKUP_LOCK_KEY, String(now));
  await env.CALENDAR_KV.put(countKey, String(count + 1), { expirationTtl: 60 * 60 * 24 * 2 });

  const result = await runBackup(env);
  return { ...result, trigger: reason, countToday: count + 1 };
}

// ===== コード更新検知バックアップ =====
// デプロイのたびにこの値を変更してください(日付や連番など、何でも構いません)。
// 値が変わると次のリクエスト時に1回だけ自動でバックアップが走ります。
const CODE_VERSION = "2026-06-30-3";
const CODE_VERSION_KV_KEY = "BACKUP_LAST_CODE_VERSION";

async function checkCodeVersionAndBackup(env, ctx) {
  if (!env.CALENDAR_KV || !env.BACKUP_BUCKET) return;
  try {
    const lastVersion = await env.CALENDAR_KV.get(CODE_VERSION_KV_KEY);
    if (lastVersion === CODE_VERSION) return; // 変化なし
    // バージョン記録を先に更新(同時に来た複数リクエストが何度も実行しないように)
    await env.CALENDAR_KV.put(CODE_VERSION_KV_KEY, CODE_VERSION);
    await triggerBackup(env, ctx, "code-deploy");
  } catch (e) {
    // バックアップ失敗が通常のリクエスト処理に影響しないようにする
  }
}
