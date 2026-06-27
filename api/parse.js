/**
 * 多平台短视频解析 Worker（仿 BugPk 返回格式）
 * 用法: GET https://你的worker地址.workers.dev/?url=视频分享链接
 *
 * 返回格式与 BugPk 保持一致，方便你的 Flutter 端少改代码：
 * {
 *   "code": 200,
 *   "msg": "解析成功",
 *   "platform": "douyin",
 *   "data": {
 *     "type": "video" | "image",
 *     "title": "",
 *     "desc": "",
 *     "author": { "name": "", "id": "", "avatar": "" },
 *     "cover": "",
 *     "url": "",
 *     "images": []
 *   }
 * }
 *
 * 维护说明：
 * - 这类解析靠抓"分享页 HTML 里嵌的 JSON"，平台改版会导致正则/JSON路径失效。
 * - 平台一旦改版，通常只需要改对应 parseXxx() 函数里的正则，不用大改架构。
 * - 部署：把这个文件内容粘到 Cloudflare Workers 的代码编辑器，或连接 GitHub 仓库自动部署。
 */

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function sendJson(res, data, statusCode) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode || 200).json(data);
}

function ok(platform, data) {
  return { _vercel: true, code: 200, msg: '解析成功', platform: platform, data: data };
}

function fail(msg, code = 500) {
  return { _vercel: true, code: code, msg: msg };
}

function detectPlatform(url) {
  if (/douyin\.com|iesdouyin\.com/.test(url)) return 'douyin';
  if (/bilibili\.com|b23\.tv/.test(url)) return 'bilibili';
  if (/kuaishou\.com|gifshow\.com|kwai/.test(url)) return 'kuaishou';
  if (/xiaohongshu\.com|xhslink\.com|xhs\.cn/.test(url)) return 'xiaohongshu';
  if (/weibo\.com/.test(url)) return 'weibo';
  return 'unknown';
}

// 跟随短链跳转，拿到最终真实地址
async function resolveRedirect(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA_MOBILE },
    });
    return res.url || url;
  } catch (e) {
    return url;
  }
}

async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA_MOBILE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

// ================= 抖音 =================
// 思路：分享短链跳转到 iesdouyin SSR 详情页，页面 HTML 里嵌有完整视频数据的 JSON（item_list），
// 直接在 HTML 中提取比调 API 更稳定（API 需要签名/登录态）
function extractDouyinItemId(url) {
  var m = url.match(/\/(?:share\/)?video\/(\d{6,})/);
  if (m) return m[1];
  m = url.match(/item_ids?=(\d{6,})/);
  if (m) return m[1];
  m = url.match(/modal_id=(\d{6,})/);
  if (m) return m[1];
  m = url.match(/aweme_id=(\d+)/);
  if (m) return m[1];
  return null;
}

// 从 HTML 中提取 item_list JSON 数组
function extractDouyinDataFromHtml(html) {
  var start = html.indexOf('"item_list":[');
  if (start < 0) return null;
  start += '"item_list":['.length;
  // 用栈匹配找到闭合的 ]
  var depth = 1;
  var inStr = false;
  var escape = false;
  for (var i = start; i < html.length && depth > 0; i++) {
    var ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"' && !escape) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') depth++;
    if (ch === ']') depth--;
  }
  if (depth !== 0) return null;
  var jsonStr = html.substring(start, i - 1);
  try {
    var arr = JSON.parse('[' + jsonStr + ']');
    return arr.length ? arr[0] : null;
  } catch(e) {
    return null;
  }
}

async function parseDouyin(originalUrl) {
  var realUrl = await resolveRedirect(originalUrl);
  var itemId = extractDouyinItemId(realUrl) || extractDouyinItemId(originalUrl);
  if (!itemId) throw new Error('未能从链接中提取视频ID');

  // 从 HTML 中提取数据
  var html = await fetchHtml(realUrl, { Referer: 'https://www.douyin.com/' });
  var item = extractDouyinDataFromHtml(html);
  if (!item) throw new Error('从页面 HTML 中提取视频数据失败，item_id=' + itemId + '，页面结构可能已变化');

  var video = item.video || {};
  var author = item.author || {};

  var playUrl = (video.play_addr && video.play_addr.url_list && video.play_addr.url_list[0]) || '';
  // 去水印：playwm -> play
  if (playUrl) playUrl = playUrl.replace('playwm', 'play');
  // unicode 转义修复
  if (playUrl) playUrl = playUrl.replace(/\\u002F/g, '/');

  var images = (item.images || [])
    .map(function(img) { return img.url_list && img.url_list[0]; })
    .filter(Boolean);

    return {
    type: images.length ? 'image' : 'video',
    title: item.desc || (item.share_info && item.share_info.share_title) || item.video && item.video.text || (item.promotions && item.promotions[0] && item.promotions[0].title) || '',
    desc: item.desc || '',
    author: {
      name: author.nickname || '',
      id: author.unique_id || author.short_id || author.uid || '',
      avatar: (author.avatar_larger && author.avatar_larger.url_list && author.avatar_larger.url_list[0]) ||
              (author.avatar_medium && author.avatar_medium.url_list && author.avatar_medium.url_list[0]) ||
              (author.avatar_thumb && author.avatar_thumb.url_list && author.avatar_thumb.url_list[0]) || '',
    },
    cover: (video.origin_cover && video.origin_cover.url_list && video.origin_cover.url_list[0]) ||
           (video.cover && video.cover.url_list && video.cover.url_list[0]) ||
           (video.dynamic_cover && video.dynamic_cover.url_list && video.dynamic_cover.url_list[0]) || '',
    url: playUrl,
    images: images,
  };
}
// ================= B站 =================
// 官方公开API，不需要登录：先拿 bvid -> view 接口拿 cid/aid -> playurl 接口拿真实流地址
async function parseBilibili(originalUrl) {
  var realUrl = originalUrl;
  if (realUrl.includes('b23.tv')) realUrl = await resolveRedirect(realUrl);

  var bvMatch = realUrl.match(/BV[0-9A-Za-z]+/);
  if (!bvMatch) throw new Error('未识别到BV号');
  var bvid = bvMatch[0];

  var info = null;
  var videoUrl = '';

  // 方式1: 调官方 API（带更多请求头）
  try {
    var viewRes = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (viewRes.ok) {
      var viewJson = await viewRes.json();
      if (viewJson.code === 0) info = viewJson.data;
    }
  } catch(e) {}

  // 方式2: 从页面 HTML 提取数据
  if (!info) {
    try {
      var html = await fetchHtml(realUrl, { Referer: 'https://www.bilibili.com/' });
      // 尝试多种 __INITIAL_STATE__ 格式
      var stateStr = null;
      var m1 = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*;?\s*(?:<\/script>|\(function)/);
      if (m1) stateStr = m1[1];
      if (!stateStr) {
        var m2 = html.match(/<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]+?)<\/script>/);
        if (m2) stateStr = m2[1];
      }
      if (stateStr) {
        try {
          var state = JSON.parse(stateStr.replace(/undefined/g, 'null'));
          var vd = state.videoData || state.videoInfo || (state.video && state.video.info) || null;
          if (vd) {
            info = {
              title: vd.title || '',
              desc: vd.desc || '',
              pic: vd.pic || '',
              owner: vd.owner || { name: '', mid: '', face: '' },
              cid: vd.cid || 0,
              aid: vd.aid || 0,
            };
          }
        } catch(e) {}
      }
      // 备选: 从 og:meta 提取
      if (!info) {
        var ogT = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
        var ogI = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
        if (ogT || ogI) {
          info = { title: ogT ? ogT[1] : '', desc: '', pic: ogI ? ogI[1] : '', owner: { name: '', mid: '', face: '' }, cid: 0, aid: 0 };
        }
      }
    } catch(e) {}
  }

  if (!info) throw new Error('获取B站视频信息失败');

  // 获取视频流地址
  if (info.cid && info.aid) {
    try {
      var playRes = await fetch('https://api.bilibili.com/x/player/playurl?avid=' + info.aid + '&cid=' + info.cid + '&qn=80&fnval=16', {
        headers: { 'User-Agent': UA_MOBILE, 'Referer': 'https://www.bilibili.com/', 'Accept': 'application/json, text/plain, */*' },
      });
      if (playRes.ok) {
        var playJson = await playRes.json();
        if (playJson.code === 0) {
          var d = playJson.data;
          if (d.dash && d.dash.video && d.dash.video.length) {
            videoUrl = d.dash.video[0].baseUrl || d.dash.video[0].base_url || '';
          } else if (d.durl && d.durl.length) {
            videoUrl = d.durl[0].url;
          }
        }
      }
    } catch(e) {}
  }

  return {
    type: 'video',
    title: info.title || '',
    desc: info.desc || '',
    author: { name: (info.owner && info.owner.name) || '', id: (info.owner && info.owner.mid && info.owner.mid.toString()) || '', avatar: (info.owner && info.owner.face) || '' },
    cover: info.pic || '',
    url: videoUrl,
    images: [],
  };
}// ================= 快手 =================
// 思路同抖音：分享页里有 window.__APOLLO_STATE__ 或 __NUXT__ 内嵌JSON
async function parseKuaishou(originalUrl) {
  var realUrl = await resolveRedirect(originalUrl);
  var html = await fetchHtml(realUrl, { Referer: 'https://www.kuaishou.com/' });

  var videoUrl = '';
  var title = '';
  var cover = '';
  var authorName = '';

  // 方式1: 从 HTML 中提取视频地址（多种模式）
  var patterns = [/"srcUrl"\s*:\s*"([^"]+)"/, /"playUrl"\s*:\s*"([^"]+)"/, /"url"\s*:\s*"([^"]*\.(?:mp4|m3u8)[^"]*)"/, /video-url=\"([^\"]+)\"/, /data-url=\"([^"']+)\"/];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m) { videoUrl = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/'); break; }
  }

  // 方式2: 从 og:meta 提取
  var ogT = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
  if (ogT) title = ogT[1];
  var ogI = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  if (ogI) cover = ogI[1];
  var ogV = html.match(/<meta[^>]*property="og:video"[^>]*content="([^"]+)"/);
  if (ogV && !videoUrl) videoUrl = ogV[1];
  var ogVU = html.match(/<meta[^>]*property="og:video:url"[^>]*content="([^"]+)"/);
  if (ogVU && !videoUrl) videoUrl = ogVU[1];

  // 方式3: 从 HTML 中提取封面
  if (!cover) {
    var cMatch = html.match(/<meta[^>]*name="og:image"[^>]*content="([^"]+)"/);
    if (cMatch) cover = cMatch[1];
  }

  // 方式4: 找作者名
  if (!authorName) {
    var aMatch = html.match(/"name"\s*:\s*"([^"]+)"\s*,\s*"avatar"/);
    if (!aMatch) aMatch = html.match(/"user_name"\s*:\s*"([^"]+)"/);
    if (!aMatch) aMatch = html.match(/"nickname"\s*:\s*"([^"]+)"/);
    if (aMatch) authorName = aMatch[1];
  }

  if (!videoUrl && !cover) {
    throw new Error('未提取到快手视频地址，页面结构可能已变化');
  }

  return {
    type: 'video',
    title: title || '',
    desc: title || '',
    author: { name: authorName || '', id: '', avatar: '' },
    cover: cover || '',
    url: videoUrl || '',
    images: [],
  };
}// ================= 小红书 =================
// 思路同抖音：详情页里有 window.__INITIAL_STATE__，但写法/转义方式可能因页面版本不同有差异，
// 这里做多种容错匹配 + 兜底用 og:meta 标签
async function parseXiaohongshu(originalUrl) {
  var realUrl = await resolveRedirect(originalUrl);
  var html = await fetchHtml(realUrl, { Referer: 'https://www.xiaohongshu.com/' });

  var videoUrl = '';
  var title = '';
  var cover = '';
  var authorName = '';
  var authorAvatar = '';
  var images = [];

  // 方式1: 从 SSR HTML 中提取封面图
  var posterMatch = html.match(/id=["']video_note_poster["'][^>]*src=["']([^"']+)["']/);
  if (posterMatch) {
    cover = posterMatch[1];
    if (cover.indexOf('http://') === 0) cover = 'https://' + cover.substring(7);
  }
  // 也尝试其他封面图
  if (!cover) {
    var ogI = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/);
    if (ogI) cover = ogI[1];
  }

  // 方式2: 从 SSR HTML 中提取标题（<title> 只有'小红书'，主要看 note-card 或其他）
  var h1Match = html.match(/note-card-title[^>]*><!--\[-->([^<]+)/);
  if (h1Match) title = h1Match[1].trim();

  // 方式3: 从 HTML 中提取作者信息
  var nameMatch = html.match(/note-card-name[^>]*><!--\[-->([^<]+)/);
  if (nameMatch) authorName = nameMatch[1].trim();
  var avaMatch = html.match(/<img[^>]*alt=["']头像["'][^>]*src=["']([^"']+)["']/);
  if (avaMatch) authorAvatar = avaMatch[1];

  // 方式4: 从 __INITIAL_STATE__ 中提取（括号匹配）
  var stateStart = html.indexOf('__INITIAL_STATE__=');
  if (stateStart >= 0) {
    stateStart += '__INITIAL_STATE__='.length;
    while (stateStart < html.length && (html[stateStart] === ' ' || html[stateStart] === '"')) stateStart++;
    if (html[stateStart] === '{') {
      var depth = 1, inStr = false, escape = false;
      var endIdx = stateStart + 1;
      for (; endIdx < html.length && depth > 0; endIdx++) {
        var ch = html[endIdx];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true; continue; }
        if (ch === '"' && !escape) { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth === 0) {
        try {
          var stateStr = html.substring(stateStart, endIdx).replace(/undefined/g, 'null');
          var state = JSON.parse(stateStr);
          var noteDetail = state.note && state.note.noteDetailMap;
          if (noteDetail) {
            var keys = Object.keys(noteDetail);
            if (keys.length) {
              var note = noteDetail[keys[0]] && noteDetail[keys[0]].note;
              if (note) {
                if (!title) title = note.title || note.desc || note.display_title || '';
                if (!authorName) authorName = (note.user && note.user.nickname) || '';
                if (!authorAvatar) authorAvatar = (note.user && note.user.avatar) || '';
                if (!cover && note.cover) cover = note.cover.urlDefault || note.cover.url || '';
                if (note.video && note.video.media && note.video.media.stream) {
                  var candidates = note.video.media.stream.h264 || note.video.media.stream.h265 || [];
                  if (candidates.length) videoUrl = candidates[0].masterUrl || (candidates[0].backupUrls && candidates[0].backupUrls[0]) || '';
                }
                if (note.imageList && note.imageList.length) {
                  note.imageList.forEach(function(img) { images.push(img.urlDefault || img.url || ''); });
                  if (!cover) cover = note.imageList[0].urlDefault || note.imageList[0].url || '';
                }
              }
            }
          }
        } catch(e) {}
      }
    }
  }

  // 方式5: 用 edith API（需要 xsec_token）
  if (!videoUrl && !images.length) {
    var noteIdMatch = realUrl.match(/\/item\/([a-f0-9]+)/);
    if (noteIdMatch) {
      var noteId = noteIdMatch[1];
      var xsecMatch = realUrl.match(/xsec_token=([^&]+)/);
      var xsec = xsecMatch ? xsecMatch[1] : '';
      if (xsec) {
        try {
          var apiUrl = 'https://edith.xiaohongshu.com/api/sns/web/v1/feed?note_id=' + noteId + '&xsec_token=' + xsec;
          var apiRes = await fetch(apiUrl, { headers: { 'User-Agent': UA_MOBILE, 'Referer': 'https://www.xiaohongshu.com/', 'Accept': 'application/json' } });
          if (apiRes.ok) {
            var apiJson = await apiRes.json();
            if (apiJson.success && apiJson.data && apiJson.data.items && apiJson.data.items.length) {
              var note = apiJson.data.items[0].note_card;
              if (note) {
                if (!title) title = note.title || note.display_title || '';
                if (!authorName) authorName = (note.user && note.user.nickname) || (note.user_info && note.user_info.nickname) || '';
                if (!cover) cover = note.cover && (note.cover.url_default || note.cover.url) || '';
                if (!videoUrl && note.video && note.video.media && note.video.media.stream) {
                  var c = note.video.media.stream.h264 || note.video.media.stream.h265 || [];
                  if (c.length) videoUrl = c[0].masterUrl || (c[0].backupUrls && c[0].backupUrls[0]) || '';
                }
                if (!images.length && note.image_list && note.image_list.length) {
                  note.image_list.forEach(function(img) { images.push(img.url_default || img.url || ''); });
                }
              }
            }
          }
        } catch(e) {}
      }
    }
  }

  // 有封面图就算成功，避免报错
  if (!videoUrl && !images.length && !cover) {
    throw new Error('未提取到小红书内容（各方案均失败），页面结构可能已变化');
  }

  return {
    type: images.length ? 'image' : 'video',
    title: title || '',
    desc: title || '',
    author: { name: authorName || '', id: '', avatar: authorAvatar || '' },
    cover: cover || '',
    url: videoUrl || '',
    images: images,
  };
}// ================= 微博 =================
async function parseWeibo(originalUrl) {
  const html = await fetchHtml(originalUrl, { Referer: 'https://weibo.com/' });

  let videoUrl = '';
  const v1 = html.match(/"stream_url_hd"\s*:\s*"([^"]+)"/) || html.match(/"stream_url"\s*:\s*"([^"]+)"/);
  if (v1) videoUrl = v1[1].replace(/\\\//g, '/');

  const titleMatch = html.match(/<meta\s+property="og:title"[^>]*content="([^"]+)"/);
  const coverMatch = html.match(/<meta\s+property="og:image"[^>]*content="([^"]+)"/);
  const authorMatch = html.match(/"screen_name"\s*:\s*"([^"]+)"/);

  if (!videoUrl) throw new Error('未提取到微博视频地址');

  return {
    type: 'video',
    title: titleMatch ? titleMatch[1] : '',
    desc: titleMatch ? titleMatch[1] : '',
    author: { name: authorMatch ? authorMatch[1] : '', id: '', avatar: '' },
    cover: coverMatch ? coverMatch[1] : '',
    url: videoUrl,
    images: [],
  };
}


// ================= 调试工具 =================
// 在 URL 上加 &debug=1 可以查看页面片段，方便定位问题
async function fetchDebugHtml(url) {
  const res = await fetch(url, { headers: {
    'User-Agent': UA_MOBILE,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  } });
  const text = await res.text();
  let debug = '=== URL ===\n' + (res.url || url) + '\n\n';
  debug += '=== 全部 HTML 前 50000 字符 ===\n' + text.substring(0, 50000) + '\n\n';
  debug += '=== script 标签摘要 ===\n';
  var scriptRe = /<script[^>]*>([\s\S]{0,800})?<\/script>/g;
  var m; var count = 0;
  while ((m = scriptRe.exec(text)) !== null && count < 30) {
    const attrs = m[0].match(/<script([^>]*)>/);
    const snippet = (m[1] || '(empty)').substring(0, 600);
    debug += '[' + count + '] <script' + (attrs ? attrs[1] : '') + '> -> ' + snippet + '\n';
    count++;
  }
  var patterns = ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__', 'RENDER_DATA', 'item_list', 'aweme_list', 'note_detail', 'play_addr'];
  debug += '\n=== JSON 数据搜索 ===\n';
  var found = false;
  patterns.forEach(function(p) {
    var idx = text.indexOf(p);
    if (idx >= 0) {
      found = true;
      var before = text.substring(Math.max(0, idx - 200), idx);
      var after = text.substring(idx, Math.min(text.length, idx + 2000));
      debug += '找到 [' + p + '] 位置: ' + idx + '\n前文: ' + before + '\n后文: ' + after + '\n\n';
    }
  });
  if (!found) debug += '(页面上没有)\n';
  return debug;
}
export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      return res.status(204).end();
    }

    const targetUrl = req.query.url;
        if (!targetUrl) return sendJson(res, { code: 400, msg: '缺少 url 参数' }, 400);
    
        // 调试模式
        if (req.query.debug === '1') {
          try {
            const debugInfo = await fetchDebugHtml(targetUrl);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.status(200).send(debugInfo);
          } catch (e) {
            return sendJson(res, { code: 500, msg: '调试抓取失败: ' + e.message }, 500);
          }
        }
    if (!targetUrl) return fail('缺少 url 参数', 400);

    const platform = detectPlatform(targetUrl);

    try {
      let data;
      switch (platform) {
        case 'douyin':
          data = await parseDouyin(targetUrl);
          break;
        case 'bilibili':
          data = await parseBilibili(targetUrl);
          break;
        case 'kuaishou':
          data = await parseKuaishou(targetUrl);
          break;
        case 'xiaohongshu':
          data = await parseXiaohongshu(targetUrl);
          break;
        case 'weibo':
          data = await parseWeibo(targetUrl);
          break;
        default:
          return sendJson(res, { code: 400, msg: '暂不支持该平台链接' }, 400);
      }
      return sendJson(res, { code: 200, msg: '解析成功', platform: platform, data: data });
    } catch (e) {
      return sendJson(res, { code: 500, msg: '解析失败: ' + (e && e.message ? e.message : String(e)) }, 500);
    }
  
}
