/**
 * Bundled DRAFT Terms of Service and Privacy Policy, shown in the app until counsel-approved
 * versions are published at EXPO_PUBLIC_TERMS_URL / EXPO_PUBLIC_PRIVACY_URL (./links.ts).
 *
 * They describe what the app and server actually do today (docs/API.md,
 * docs/STORE_COMPLIANCE.md). Bracketed placeholders are for the owner to fill in.
 * Every screen showing them carries the "DRAFT — pending counsel review" banner.
 */
import type { Locale } from '../i18n/resolve';
import type { LegalDoc } from './links';

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export interface LegalDocument {
  title: string;
  version: string;
  /** Review state of this translation. */
  review: 'n/a' | 'first pass, needs native review';
  sections: LegalSection[];
}

export const LEGAL_VERSION = 'DRAFT 2026-11-12';

const TERMS_EN: LegalDocument = {
  title: 'Terms of Service',
  version: LEGAL_VERSION,
  review: 'n/a',
  sections: [
    {
      heading: '1. Who we are',
      paragraphs: ['These terms are an agreement between you and [Company name] ("we"), the publisher of this app. By using the app you accept them. If you do not accept them, please do not use the app.'],
    },
    {
      heading: '2. Who may play',
      paragraphs: ['The app contains simulated gambling and is rated 18+. You must be at least 18 years old to use it. We ask for your birth year when you first open the app and may close accounts that we believe belong to someone younger.'],
    },
    {
      heading: '3. Your account',
      paragraphs: [
        'The app can make a guest account for you on our game server. You can link it to Sign in with Apple or Google so it is not lost with your device. Keep your device secure; you are responsible for what happens on your account.',
        'You can delete your account at any time in Settings. Deletion removes your name, sign-in methods and club memberships, and takes your name out of match results, archived club seasons and reports. Purchase records are kept as financial records, and reports as moderation records without your name (see the Privacy Policy, section 6).',
      ],
    },
    {
      heading: '4. Diamonds, table looks and coaching plans',
      paragraphs: [
        'Diamonds and points have no monetary value and cannot be redeemed or transferred. They cannot be exchanged for money, goods or anything of value, sold, or moved to another player, inside or outside the app.',
        'Diamonds and table looks are a limited, personal, revocable licence to use digital content in the app. Purchased diamonds do not expire. Diamonds are spent only on items listed in the Shop at the price shown there.',
        'Subscriptions (Coach Gold, The Four Winds Club) are monthly or yearly plans. A monthly plan renews and is charged every month, a yearly plan every year, until you cancel it in your App Store or Google Play account settings. Payment, renewal and refunds are handled by the store you bought through, under its terms.',
        'Nothing you can buy changes the tiles you are dealt, what you can see at the table, or the clock.',
      ],
    },
    {
      heading: '5. Clubs and fair play',
      paragraphs: [
        'Joining a club and playing in it is free. Creating and running a club needs The Four Winds Club. Club standings are points only. You must not use the app, a club or a table to organise, settle or record wagers of real money or anything of value, or to act as an agent for anyone who does. We may close clubs and accounts that do.',
        'Do not cheat: no collusion, no software that plays or advises for you at live tables, no exploiting bugs, no sharing information about your hand with other players at the table.',
        'Be decent: no harassment, hate, threats, impersonation or offensive names. You can report a player from the table; we review reports and may warn, suspend or close accounts.',
      ],
    },
    {
      heading: '6. The shuffle',
      paragraphs: ['Every online hand uses a shuffle that each seat helps to seed and that the app checks after the hand (see "Fair play" in the app). If a check fails, the app tells you.'],
    },
    {
      heading: '7. Changes, suspension and ending',
      paragraphs: ['We may change the app, these terms or the Shop. We will tell you in the app before a material change to these terms applies to you. We may suspend or close an account that breaks these terms. You may stop using the app at any time.'],
    },
    {
      heading: '8. Liability',
      paragraphs: ['The app is provided as it is. To the extent the law allows, we are not liable for indirect or consequential loss, or for losses caused by events outside our control. Nothing in these terms limits rights you have under consumer law that cannot be limited.'],
    },
    {
      heading: '9. Law and contact',
      paragraphs: ['These terms are governed by the laws of [jurisdiction]. Questions: [support email].'],
    },
  ],
};

const TERMS_ZH: LegalDocument = {
  title: '服務條款',
  version: LEGAL_VERSION,
  review: 'first pass, needs native review',
  sections: [
    {
      heading: '1. 我們是誰',
      paragraphs: ['本條款是你與本 App 發行者 [公司名稱]（以下稱「我們」）之間的協議。使用本 App 即表示你同意本條款；如不同意，請勿使用。'],
    },
    {
      heading: '2. 誰可以玩',
      paragraphs: ['本 App 含有模擬賭博內容，分級為 18 歲以上。你必須年滿 18 歲才能使用。首次開啟時我們會詢問你的出生年份，並可能關閉我們認為屬於未滿年齡者的帳號。'],
    },
    {
      heading: '3. 你的帳號',
      paragraphs: [
        'App 可以在我們的遊戲伺服器上為你建立訪客帳號。你可以連結 Apple 或 Google 登入，避免帳號隨裝置遺失。請妥善保管你的裝置；你須為帳號上發生的事負責。',
        '你可以隨時在「設定」中刪除帳號。刪除會移除你的名稱、登入方式和俱樂部成員資格，並把你的名稱從比賽結果、已封存的俱樂部賽季和檢舉紀錄中拿掉。購買紀錄會作為財務紀錄保留，檢舉紀錄則去除名稱後作為管理紀錄保留（詳見隱私權政策第 6 條）。',
      ],
    },
    {
      heading: '4. 鑽石、桌布與教練方案',
      paragraphs: [
        '鑽石與積分沒有金錢價值，不能兌換或轉讓。不論在 App 內外，都不能換成金錢、商品或任何有價物，不能出售，也不能轉給其他玩家。',
        '鑽石與桌布是在 App 內使用數位內容的有限、個人、可撤銷的授權。購買的鑽石不會過期。鑽石只能用來購買商店中列出的商品，價格以商店顯示為準。',
        '訂閱方案（教練 金、四風俱樂部）分為月繳和年繳。月繳方案每月自動續訂並扣款一次，年繳方案每年一次，直到你在 App Store 或 Google Play 帳號設定中取消為止。付款、續訂與退款由你購買時使用的商店依其條款處理。',
        '任何可購買的東西都不會改變你拿到的牌、你在牌桌上能看到的資訊或計時。',
      ],
    },
    {
      heading: '5. 俱樂部與公平遊戲',
      paragraphs: [
        '加入俱樂部並在其中打牌免費；開設並經營俱樂部需要四風俱樂部方案。俱樂部排行只計積分。你不得利用本 App、俱樂部或牌桌安排、結算或記錄任何真錢或有價物的賭注，也不得替這樣做的人擔任代理。我們可能關閉這類俱樂部和帳號。',
        '不得作弊：不得串通、不得在真人牌桌使用代打或提示軟體、不得利用程式錯誤、不得向同桌玩家透露手牌資訊。',
        '請保持禮貌：不得騷擾、仇恨言論、威脅、冒充他人或使用冒犯性名稱。你可以在牌桌上檢舉玩家；我們會審查檢舉，並可能警告、停權或關閉帳號。',
      ],
    },
    {
      heading: '6. 洗牌',
      paragraphs: ['每一手線上牌局都使用由每個座位共同產生種子、並在牌局結束後由 App 驗證的洗牌（見 App 內的「公平遊戲」）。驗證失敗時，App 會告訴你。'],
    },
    {
      heading: '7. 變更、停權與終止',
      paragraphs: ['我們可能變更 App、本條款或商店。本條款有重大變更時，我們會在生效前於 App 內通知你。違反本條款的帳號可能被停權或關閉。你可以隨時停止使用本 App。'],
    },
    {
      heading: '8. 責任',
      paragraphs: ['本 App 依現狀提供。在法律允許的範圍內，我們不對間接或衍生損失、或我們無法控制的事件造成的損失負責。本條款不限制你依消費者保護法享有且不得限制的權利。'],
    },
    {
      heading: '9. 準據法與聯絡方式',
      paragraphs: ['本條款以 [管轄地] 法律為準據法。如有問題：[客服信箱]。'],
    },
  ],
};

const PRIVACY_EN: LegalDocument = {
  title: 'Privacy Policy',
  version: LEGAL_VERSION,
  review: 'n/a',
  sections: [
    {
      heading: '1. What this covers',
      paragraphs: ['This policy explains what [Company name] collects through the app and the game server, why, and your choices. Questions or requests: [support email].'],
    },
    {
      heading: '2. Playing offline',
      paragraphs: ['Games against bots, lessons and puzzles run on your device. Your name, avatar, settings, progress and birth year are stored on the device and are not sent anywhere until you use an online feature.'],
    },
    {
      heading: '3. What we collect when you go online',
      paragraphs: [
        'Account: an account id, a display name and avatar you choose, your language, your birth year, and your two privacy choices (usage statistics and crash reports, each on or off). If you link Sign in with Apple or Google: the provider’s account identifier and, if the provider shares it, a verified email address.',
        'Device: a random device id created by the app, the platform (iOS, Android or web), the app build and, if you allow notifications, a push notification token.',
        'Play: the tables you join, the hands played (including the shuffle record used to verify fairness), match results, club memberships and club standings, the players you block, and the reports you make.',
        'Purchases: the product, store transaction id, price and currency, received from the App Store or Google Play through our payment processor, RevenueCat, which receives your account id to link purchases to your account. We never see your card details.',
        'Diagnostics and usage: crash reports and app events, used to fix problems and improve the app. Both are off until you agree: the app asks once, after the age question, and you can switch either one on or off at any time in Settings, under Privacy. They exist only in builds that carry these services.',
      ],
    },
    {
      heading: '4. Why we use it',
      paragraphs: ['To run your account and online tables, keep standings, verify each shuffle, deliver what you buy, prevent cheating and abuse, answer you, and meet legal obligations. We do not sell your personal information and we do not use it for advertising.'],
    },
    {
      heading: '5. Who else sees it',
      paragraphs: ['Other players at your table and in your clubs see your display name, avatar, results and standings. Our hosting, database, payment, notification delivery and (only if you agreed) diagnostics and usage providers process data for us under contract. A notification is delivered through Expo’s push service, which passes it to Apple or Google with your push notification token. We disclose data when the law requires it.'],
    },
    {
      heading: '6. How long we keep it',
      paragraphs: ['Account data is kept while your account exists. When you delete your account in Settings we remove your name, avatar, email, sign-in methods, devices, push notification tokens, block list and sessions at once, and replace your name with "Deleted player" in your club entries, in match results and in archived club seasons. What remains of the account is erased within 30 days.', 'Three kinds of record are kept after that, none of them carrying your name: match results and archived club standings, which stay as long as the club or table history they belong to; reports you made and reports made about you, kept as moderation records for as long as the service runs; and purchase and wallet records, kept for as long as tax and accounting law requires.'],
    },
    {
      heading: '7. Your choices and rights',
      paragraphs: ['You can change your name and avatar, unlink a sign-in method, switch usage statistics and crash reports on or off, and delete your account in Settings. You can block a player from the table, and turn notifications off in your device settings. Depending on where you live you may have rights to access, correct, export or object to the use of your data; contact [support email].'],
    },
    {
      heading: '8. Children',
      paragraphs: ['The app is for people aged 18 and over. If you have entered a birth year under the limit the app does not let you in; if we learn an account belongs to a child we delete it.'],
    },
    {
      heading: '9. Changes',
      paragraphs: ['We will update this policy when what we collect changes, and tell you in the app before a material change applies.'],
    },
  ],
};

const PRIVACY_ZH: LegalDocument = {
  title: '隱私權政策',
  version: LEGAL_VERSION,
  review: 'first pass, needs native review',
  sections: [
    {
      heading: '1. 適用範圍',
      paragraphs: ['本政策說明 [公司名稱] 透過 App 與遊戲伺服器蒐集哪些資料、用途為何，以及你可以做的選擇。如有問題或請求：[客服信箱]。'],
    },
    {
      heading: '2. 離線遊玩',
      paragraphs: ['與電腦對戰、課程和謎題都在你的裝置上執行。你的名稱、頭像、設定、進度和出生年份儲存在裝置上，在你使用線上功能之前不會傳送到任何地方。'],
    },
    {
      heading: '3. 上線時我們蒐集的資料',
      paragraphs: [
        '帳號：帳號 ID、你選擇的顯示名稱和頭像、語言、出生年份，以及你的兩項隱私選擇（使用統計與當機報告，各自開啟或關閉）。若你連結 Apple 或 Google 登入：該服務的帳號識別碼，以及（若對方提供）經驗證的電子郵件。',
        '裝置：App 產生的隨機裝置 ID、平台（iOS、Android 或網頁）、App 版本，以及在你允許通知時的推播通知權杖。',
        '遊玩：你加入的牌桌、打過的牌局（包括用來驗證公平性的洗牌紀錄）、比賽結果、俱樂部成員資格與排行、你封鎖的玩家，以及你提出的檢舉。',
        '購買：商品、商店交易編號、價格與幣別，由 App Store 或 Google Play 透過我們的金流服務商 RevenueCat 提供；RevenueCat 會收到你的帳號 ID，以便將購買連結到你的帳號。我們不會看到你的信用卡資料。',
        '診斷與使用情形：當機報告和 App 事件，用來修正問題與改善 App。兩項在你同意之前都是關閉的：App 會在詢問年齡之後問你一次，之後隨時可以到「設定」的「隱私權」分別開啟或關閉。只有內含這些服務的版本才會有這兩項。',
      ],
    },
    {
      heading: '4. 使用目的',
      paragraphs: ['用來維持你的帳號與線上牌桌、記錄排行、驗證每次洗牌、交付你購買的內容、防止作弊與濫用、回覆你，以及履行法律義務。我們不出售你的個人資料，也不用於廣告。'],
    },
    {
      heading: '5. 還有誰會看到',
      paragraphs: ['同桌和同俱樂部的玩家會看到你的顯示名稱、頭像、成績與排行。我們的主機、資料庫、金流、通知傳送，以及（僅在你同意時）診斷與使用統計服務商依合約為我們處理資料。通知是透過 Expo 的推播服務傳送，該服務會連同你的推播通知權杖轉交給 Apple 或 Google。法律要求時我們會揭露資料。'],
    },
    {
      heading: '6. 保存期間',
      paragraphs: ['帳號存在期間會保存帳號資料。你在「設定」中刪除帳號時，我們會立即移除你的名稱、頭像、電子郵件、登入方式、裝置、推播通知權杖、封鎖名單與工作階段，並把你在俱樂部紀錄、比賽結果和已封存俱樂部賽季中的名稱改為「已刪除的玩家」。帳號剩下的資料會在 30 天內清除。', '在那之後仍會保留三類紀錄，而且都不含你的名稱：比賽結果與已封存的俱樂部排行，隨所屬俱樂部或牌桌的歷史紀錄一起保存；你提出的檢舉和別人對你提出的檢舉，在服務營運期間作為管理紀錄保存；購買與錢包紀錄，依稅務與會計法規要求的期間保存。'],
    },
    {
      heading: '7. 你的選擇與權利',
      paragraphs: ['你可以在「設定」中修改名稱與頭像、取消連結登入方式、開啟或關閉使用統計與當機報告，以及刪除帳號。你可以在牌桌上封鎖玩家，也可以在裝置設定中關閉通知。依你所在地區，你可能有查詢、更正、匯出或反對使用個人資料的權利；請聯絡 [客服信箱]。'],
    },
    {
      heading: '8. 兒童',
      paragraphs: ['本 App 適用於 18 歲以上的使用者。若你輸入的出生年份未達年齡限制，App 不會讓你進入；若我們得知帳號屬於兒童，會將其刪除。'],
    },
    {
      heading: '9. 變更',
      paragraphs: ['蒐集的資料有所變動時我們會更新本政策，並在重大變更生效前於 App 內通知你。'],
    },
  ],
};

export const LEGAL_DOCUMENTS: Record<LegalDoc, Record<Locale, LegalDocument>> = {
  terms: { en: TERMS_EN, 'zh-TW': TERMS_ZH },
  privacy: { en: PRIVACY_EN, 'zh-TW': PRIVACY_ZH },
};

/** The placeholder the drafts print where the support address goes, per language. */
const SUPPORT_PLACEHOLDERS = ['[support email]', '[客服信箱]'];

/**
 * The bundled text in the app's language. `supportAddress` (the build's support address or help page,
 * src/legal/support.ts) replaces the support placeholder; without one the placeholder stays, as the other
 * owner-to-fill placeholders do, under the draft banner.
 */
export function legalDocument(doc: LegalDoc, locale: Locale, supportAddress?: string | null): LegalDocument {
  const d = LEGAL_DOCUMENTS[doc][locale] ?? LEGAL_DOCUMENTS[doc].en;
  if (!supportAddress) return d;
  const fill = (text: string) => SUPPORT_PLACEHOLDERS.reduce((t, ph) => t.split(ph).join(supportAddress), text);
  return { ...d, sections: d.sections.map((s) => ({ ...s, paragraphs: s.paragraphs.map(fill) })) };
}
