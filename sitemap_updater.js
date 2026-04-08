/**
 * ============================================================
 * Delta Force Wiki - サイトマップ自動生成スクリプト
 * ============================================================
 *
 * 【初期設定手順】
 * 1. GASエディタ左メニューの「プロジェクトの設定」>「スクリプト プロパティ」を開く
 * 2. 以下の4つのプロパティを追加する：
 *    - キー: GITHUB_TOKEN   値: GitHubのPersonal Access Token（スコープ: public_repo）
 *    - キー: GITHUB_OWNER   値: GitHubのユーザー名（例: your-github-username）
 *    - キー: GITHUB_REPO    値: リポジトリ名（例: df-wiki-sitemap）
 *    - キー: GITHUB_BRANCH  値: ブランチ名（通常は main）
 *
 * 【実行方法】
 * - GASエディタで updateSitemap() を選択して「実行」ボタンを押す
 * - 実行後、GitHubのCommit Diffで差分を目視確認する
 * - 問題なければsitemap.xmlをダウンロードしてサーバー管理者にメール送付する
 * ============================================================
 */

// ============================================================
// 設定定数ブロック（ここだけ編集すれば動作をカスタマイズできる）
// ※ GitHubの認証情報・リポジトリ情報はスクリプトプロパティで管理する（上記参照）
// ============================================================
const CONFIG = {
  // SwikiページURL
  SWIKI_LIST_URL: 'https://df.swiki.jp/?cmd=list',

  // GitHubファイルパス（リポジトリ内でのsitemap.xmlの位置）
  GITHUB_FILE_PATH: 'sitemap.xml',

  // 新規URLに付与するデフォルト値
  DEFAULT_CHANGEFREQ: 'monthly',
  DEFAULT_PRIORITY:   '0.3',

  // バリデーション閾値
  MIN_URL_COUNT:      1,    // 抽出URL数がこれを下回ったらPush中止
  URL_DROP_THRESHOLD: 0.5,  // 既存URL数に対してこの割合を下回ったらPush中止

  // リトライ設定
  MAX_RETRIES:   3,
  RETRY_BASE_MS: 2000,  // 初回リトライ待機時間（ms）。以降は2倍ずつ増加

  // 除外するページのブラックリスト（デコード済みURLで統一）
  BLACKLIST: [
    'https://df.swiki.jp/index.php?テンプレート置き場',
    'https://df.swiki.jp/index.php?銃器テンプレート',
    'https://df.swiki.jp/index.php?編集方針話し合い',
    'https://df.swiki.jp/index.php?Sandbox',
    'https://df.swiki.jp/index.php?materials',
  ],
};

// ============================================================
// スクリプトプロパティ読み込み
// ============================================================

/**
 * スクリプトプロパティから環境変数を読み込む
 * 未設定のキーがあれば起動時点でまとめてエラーを出す
 * @returns {{ token: string, owner: string, repo: string, branch: string }}
 */
function loadEnv() {
  const props   = PropertiesService.getScriptProperties();
  const KEYS    = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH'];
  const missing = KEYS.filter(k => !props.getProperty(k));

  if (missing.length > 0) {
    throw new Error(
      `[設定エラー] スクリプトプロパティに以下のキーが設定されていません: ${missing.join(', ')}\n` +
      'GASエディタ →「プロジェクトの設定」→「スクリプトプロパティ」で追加してください。'
    );
  }

  return {
    token:  props.getProperty('GITHUB_TOKEN'),
    owner:  props.getProperty('GITHUB_OWNER'),
    repo:   props.getProperty('GITHUB_REPO'),
    branch: props.getProperty('GITHUB_BRANCH'),
  };
}

// ============================================================
// エントリーポイント（GASエディタから実行する関数）
// ============================================================
function updateSitemap() {
  Logger.log('=== サイトマップ更新開始 ===');

  // 環境変数の読み込み（未設定があればここで即時エラー）
  const env = loadEnv();

  // Step 1: Swikiからページ一覧を取得・パース
  Logger.log('[1/5] Swikiページ一覧を取得中...');
  const swikiEntries = fetchSwikiEntries();
  Logger.log(`  → ${swikiEntries.size} 件のURLを抽出`);

  // Step 2: GitHubから既存sitemap.xmlを取得
  Logger.log('[2/5] GitHubから既存sitemap.xmlを取得中...');
  const { sha, content: existingXml } = fetchGitHubFile(env);
  const existingUrlCount = (existingXml.match(/<loc>/g) || []).length;
  Logger.log(`  → 既存エントリ数: ${existingUrlCount} 件`);

  // Step 3: バリデーション
  Logger.log('[3/5] バリデーション実行中...');
  validateEntries(swikiEntries, existingUrlCount);
  Logger.log('  → バリデーション通過');

  // Step 4: マージ（テキストベース）
  Logger.log('[4/5] マージ処理中...');
  const { mergedXml, updatedCount, addedCount } = mergeXml(existingXml, swikiEntries);
  Logger.log(`  → lastmod更新: ${updatedCount} 件、新規追加: ${addedCount} 件`);

  // Step 5: GitHubにPush
  Logger.log('[5/5] GitHubにPush中...');
  pushToGitHub(mergedXml, sha, env);

  Logger.log('=== 完了 ===');
  Logger.log('GitHubのCommit Diffで差分を確認してください。');
}

// ============================================================
// Step 1: Swikiからエントリを取得・パース
// ============================================================

/**
 * Swikiページ一覧をフェッチし、{デコード済みURL -> lastmod文字列} のMapを返す
 * @returns {Map<string, string>}
 */
function fetchSwikiEntries() {
  const response = UrlFetchApp.fetch(CONFIG.SWIKI_LIST_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error(`Swikiフェッチ失敗: HTTP ${response.getResponseCode()}`);
  }
  const html = response.getContentText('UTF-8');
  return parseSwikiHtml(html);
}

/**
 * HTMLからURLとlastmodを抽出する
 * @param {string} html
 * @returns {Map<string, string>}  key=デコード済みURL, value=lastmod(YYYY-MM-DD)
 */
function parseSwikiHtml(html) {
  const entries = new Map();
  const pattern = /<a\s+href="([^"#]+)"[^>]*>[^<]*<\/a><small>\((\d+)([dh])\)<\/small>/g;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const rawUrl = match[1];
    const amount = parseInt(match[2], 10);
    const unit   = match[3];

    if (shouldExclude(rawUrl)) continue;

    const decodedUrl = decodeUrl(rawUrl);
    const lastmod    = calcLastmod(amount, unit);

    // 同一URLが複数回出現した場合は最初のもの（より新しい更新日）を優先
    if (!entries.has(decodedUrl)) {
      entries.set(decodedUrl, lastmod);
    }
  }

  return entries;
}

/**
 * 除外判定
 * @param {string} rawUrl
 * @returns {boolean}
 */
function shouldExclude(rawUrl) {
  if (rawUrl.startsWith('#')) return true;
  if (rawUrl.includes('Comments%2F') || rawUrl.includes('Comments/')) return true;
  const decoded = decodeUrl(rawUrl);
  if (CONFIG.BLACKLIST.includes(decoded)) return true;
  return false;
}

/**
 * URLデコード（エラー時は元のURLを返す）
 * @param {string} url
 * @returns {string}
 */
function decodeUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch (e) {
    return url;
  }
}

/**
 * 経過時間からlastmod日付を算出する
 * @param {number} amount
 * @param {string} unit  'd' or 'h'
 * @returns {string}  YYYY-MM-DD
 */
function calcLastmod(amount, unit) {
  const now = new Date();
  if (unit === 'd') {
    now.setDate(now.getDate() - amount);
  } else if (unit === 'h') {
    // 時間単位は日付のみに丸める（計算誤差の影響を限定）
    now.setHours(now.getHours() - amount);
  }
  return formatDate(now);
}

/**
 * DateオブジェクトをYYYY-MM-DD形式に変換
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================================
// Step 2: GitHubから既存ファイルを取得
// ============================================================

/**
 * GitHub APIからsitemap.xmlを取得する
 * @param {{ token: string, owner: string, repo: string, branch: string }} env
 * @returns {{ sha: string, content: string }}
 */
function fetchGitHubFile(env) {
  const url      = `https://api.github.com/repos/${env.owner}/${env.repo}/contents/${CONFIG.GITHUB_FILE_PATH}?ref=${env.branch}`;
  const response = githubRequest('GET', url, null, env);
  const json     = JSON.parse(response.getContentText());
  const content  = Utilities.newBlob(Utilities.base64Decode(json.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { sha: json.sha, content };
}

// ============================================================
// Step 3: バリデーション
// ============================================================

/**
 * Push前の安全チェック
 * @param {Map} swikiEntries
 * @param {number} existingUrlCount
 */
function validateEntries(swikiEntries, existingUrlCount) {
  const count = swikiEntries.size;

  if (count < CONFIG.MIN_URL_COUNT) {
    throw new Error(`[バリデーションエラー] 抽出URL数が ${count} 件です。フェッチ結果が空の可能性があります。Pushを中止しました。`);
  }

  if (existingUrlCount > 0 && count < existingUrlCount * CONFIG.URL_DROP_THRESHOLD) {
    throw new Error(`[バリデーションエラー] 抽出URL数(${count}件)が既存URL数(${existingUrlCount}件)の${CONFIG.URL_DROP_THRESHOLD * 100}%を下回っています。Pushを中止しました。`);
  }
}

// ============================================================
// Step 4: テキストベースマージ
// ============================================================

/**
 * 既存XMLにSwikiエントリをマージする
 *
 * 処理方針:
 * - 既存の <url> ブロックを1件ずつ処理し、<lastmod> のみ更新する
 * - カテゴリコメント・priority・changefreq・URL順序は一切変更しない
 * - 既存XMLに存在しない新規URLは「未分類（自動追加）」セクションに追記する
 *
 * @param {string} existingXml
 * @param {Map<string, string>} swikiEntries  key=デコード済みURL, value=lastmod
 * @returns {{ mergedXml: string, updatedCount: number, addedCount: number }}
 */
function mergeXml(existingXml, swikiEntries) {
  let updatedCount = 0;

  // 既存XMLに登場するURLを記録（新規判定に使う）
  const processedUrls = new Set();

  // <url>...</url> ブロックを1件ずつ置換
  const merged = existingXml.replace(
    /(<url>\s*<loc>)([\s\S]*?)(<\/loc>\s*<lastmod>)([\s\S]*?)(<\/lastmod>[\s\S]*?<\/url>)/g,
    (fullMatch, locOpen, rawLoc, lastmodOpen, oldLastmod, tail) => {
      const loc     = rawLoc.trim();
      const decoded = decodeUrl(loc);
      processedUrls.add(decoded);

      const newLastmod = swikiEntries.get(decoded);
      if (newLastmod && newLastmod !== oldLastmod.trim()) {
        updatedCount++;
        return `${locOpen}${loc}${lastmodOpen}${newLastmod}${tail}`;
      }
      return fullMatch;
    }
  );

  // 新規URL（既存XMLに存在しないもの）を収集
  const newEntries = [];
  for (const [decodedUrl, lastmod] of swikiEntries) {
    if (!processedUrls.has(decodedUrl)) {
      newEntries.push({ url: decodedUrl, lastmod });
    }
  }

  // 新規URLを「未分類（自動追加）」セクションとして</urlset>直前に挿入
  let finalXml = merged;
  if (newEntries.length > 0) {
    const newBlock = buildNewSection(newEntries);
    finalXml = merged.replace('</urlset>', newBlock + '\n</urlset>');
  }

  return { mergedXml: finalXml, updatedCount, addedCount: newEntries.length };
}

/**
 * 新規URLのセクションブロックを生成する
 * @param {Array<{url: string, lastmod: string}>} entries
 * @returns {string}
 */
function buildNewSection(entries) {
  const urlBlocks = entries.map(({ url, lastmod }) => [
    '  <url>',
    `    <loc>${url}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${CONFIG.DEFAULT_CHANGEFREQ}</changefreq>`,
    `    <priority>${CONFIG.DEFAULT_PRIORITY}</priority>`,
    '  </url>',
  ].join('\n')).join('\n');

  return `  <!-- 未分類（自動追加） -->\n${urlBlocks}`;
}

// ============================================================
// Step 5: GitHubへPush
// ============================================================

/**
 * sitemap.xmlをGitHubにPushする
 * @param {string} content
 * @param {string} sha
 * @param {{ token: string, owner: string, repo: string, branch: string }} env
 */
function pushToGitHub(content, sha, env) {
  const url     = `https://api.github.com/repos/${env.owner}/${env.repo}/contents/${CONFIG.GITHUB_FILE_PATH}`;
  const today   = formatDate(new Date());
  const payload = {
    message: `chore: update sitemap.xml [${today}]`,
    content: Utilities.base64Encode(Utilities.newBlob(content, 'UTF-8').getBytes()),
    sha:     sha,
    branch:  env.branch,
  };
  githubRequest('PUT', url, payload, env);
}

// ============================================================
// GitHub API 共通リクエスト関数（リトライ付き）
// ============================================================

/**
 * GitHub APIへのリクエスト（指数バックオフリトライ付き）
 * @param {string} method  'GET' | 'PUT'
 * @param {string} url
 * @param {Object|null} payload
 * @param {{ token: string }} env
 * @returns {HTTPResponse}
 */
function githubRequest(method, url, payload, env) {
  const options = {
    method:  method,
    headers: {
      'Authorization':        `Bearer ${env.token}`,
      'Content-Type':         'application/json',
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    muteHttpExceptions: true,
  };
  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  let lastError;
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const code     = response.getResponseCode();

    // 成功
    if (code === 200 || code === 201) {
      if (attempt > 1) Logger.log(`  → ${attempt} 回目の試行で成功 (HTTP ${code})`);
      return response;
    }

    // 即時失敗（リトライ無意味）
    if (code === 401 || code === 403 || code === 404 || code === 422) {
      throw new Error(`[GitHub APIエラー] HTTP ${code}: ${response.getContentText()}`);
    }

    // リトライ対象（429: Rate Limit, 5xx: サーバーエラー）
    const waitMs = CONFIG.RETRY_BASE_MS * Math.pow(2, attempt - 1);
    lastError = `HTTP ${code}: ${response.getContentText().substring(0, 200)}`;
    Logger.log(`  → 試行 ${attempt}/${CONFIG.MAX_RETRIES} 失敗 (${lastError})。${waitMs}ms 後にリトライ...`);
    Utilities.sleep(waitMs);
  }

  throw new Error(`[GitHub APIエラー] ${CONFIG.MAX_RETRIES} 回のリトライ後も失敗しました。最後のエラー: ${lastError}`);
}
