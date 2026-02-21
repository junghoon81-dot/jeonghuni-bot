import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "@/lib/system-prompt";

// ── Telegram 타입 ──
interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string };
  text?: string;
  reply_to_message?: TelegramMessage;
  entities?: { type: string; offset: number; length: number; user?: TelegramUser }[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ── 환경변수 ──
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const BOT_USERNAME = process.env.BOT_USERNAME || "jeonghuni_bot"; // @username without @

// ── Anthropic 클라이언트 ──
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── 최근 대화 컨텍스트 (인메모리, chat_id별) ──
const chatContexts = new Map<number, { role: "user" | "assistant"; content: string }[]>();
const MAX_CONTEXT = 20; // 최근 20개 메시지까지 기억

// ── Telegram API 헬퍼 ──
async function sendMessage(chatId: number, text: string, replyToMessageId?: number) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      parse_mode: "Markdown",
    }),
  });
  return res.json();
}

async function editMessage(chatId: number, messageId: number, text: string) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // editMessage 실패 시 무시 (동일 텍스트 등)
  }
}

// ── 봇이 멘션되었는지 확인 ──
function isBotMentioned(message: TelegramMessage): boolean {
  const text = message.text || "";

  // @username 멘션 확인
  if (text.includes(`@${BOT_USERNAME}`)) return true;

  // "정후니" 키워드 확인
  if (text.includes("정후니")) return true;

  // entities에서 멘션 확인
  if (message.entities) {
    for (const entity of message.entities) {
      if (entity.type === "mention") {
        const mentionText = text.substring(entity.offset, entity.offset + entity.length);
        if (mentionText === `@${BOT_USERNAME}`) return true;
      }
      if (entity.type === "text_mention" && entity.user?.username === BOT_USERNAME) {
        return true;
      }
    }
  }

  // 봇의 메시지에 직접 리플라이
  if (message.reply_to_message?.from?.username === BOT_USERNAME) return true;

  return false;
}

// ── 발신자 이름 추출 ──
function getSenderName(user?: TelegramUser): string {
  if (!user) return "알 수 없음";
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(" ") || user.username || "알 수 없음";
}

// ── 대화 컨텍스트 관리 ──
function addToContext(chatId: number, role: "user" | "assistant", content: string) {
  if (!chatContexts.has(chatId)) {
    chatContexts.set(chatId, []);
  }
  const ctx = chatContexts.get(chatId)!;
  ctx.push({ role, content });
  // MAX_CONTEXT 초과 시 오래된 것부터 제거
  while (ctx.length > MAX_CONTEXT) {
    ctx.shift();
  }
}

function getContext(chatId: number): { role: "user" | "assistant"; content: string }[] {
  return chatContexts.get(chatId) || [];
}

// ── 메인 웹훅 핸들러 ──
export async function POST(request: NextRequest) {
  try {
    const update: TelegramUpdate = await request.json();

    // 메시지가 없으면 무시
    if (!update.message?.text) {
      return NextResponse.json({ ok: true });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;
    const sender = message.from;
    const senderName = getSenderName(sender);
    const isBot = sender?.is_bot || false;

    // 봇이 멘션되지 않았으면 무시 (단체방)
    if (message.chat.type !== "private" && !isBotMentioned(message)) {
      return NextResponse.json({ ok: true });
    }

    // @mention 부분 제거
    const cleanText = (text || "")
      .replace(new RegExp(`@${BOT_USERNAME}`, "g"), "")
      .replace(/정후니/g, "")
      .trim();

    if (!cleanText) {
      await sendMessage(chatId, "네, 부르셨습니까? 무엇을 도와드릴까요?", message.message_id);
      return NextResponse.json({ ok: true });
    }

    // "생각 중..." 메시지 전송
    const thinkingMsg = await sendMessage(chatId, "🤔 생각 중...", message.message_id);
    const thinkingMsgId = thinkingMsg?.result?.message_id;

    // 시스템 프롬프트 선택 (발신자에 따라)
    const systemPrompt = getSystemPrompt(senderName, isBot);

    // 대화 컨텍스트에 추가
    const userContent = `[${senderName}]: ${cleanText}`;
    addToContext(chatId, "user", userContent);

    // Claude API 호출
    const messages = getContext(chatId).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    // 응답 텍스트 추출
    const assistantText =
      response.content
        .filter((block) => block.type === "text")
        .map((block) => {
          if (block.type === "text") return block.text;
          return "";
        })
        .join("") || "죄송합니다, 응답을 생성하지 못했습니다.";

    // 컨텍스트에 응답 추가
    addToContext(chatId, "assistant", assistantText);

    // "생각 중..." 메시지를 실제 응답으로 교체
    if (thinkingMsgId) {
      await editMessage(chatId, thinkingMsgId, assistantText);
    } else {
      await sendMessage(chatId, assistantText, message.message_id);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json({ ok: true }); // Telegram에 200 반환 (재시도 방지)
  }
}

// ── GET: 상태 확인용 ──
export async function GET() {
  return NextResponse.json({
    status: "정후니 봇 작동 중",
    timestamp: new Date().toISOString(),
  });
}
