import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import axios from "axios";

export const identityVerificationTool = createTool({
  id: "identity-verification",
  description: "本人確認書類のOCRテキストを分析し、Kintone情報と照合するツール",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    identityDocuments: z.array(z.object({
      fileName: z.string(),
      text: z.string(),
      pageCount: z.number(),
    })).describe("OCR処理済みの本人確認書類"),
    model: z.string().describe("使用するAIモデル").default("gpt-4o"),
  }),
  
  outputSchema: z.object({
    success: z.boolean(),
    persons: z.array(z.object({
      name: z.string().describe("抽出した氏名"),
      birthDate: z.string().optional().describe("抽出した生年月日"),
      address: z.string().optional().describe("抽出した住所"),
      nameMatch: z.boolean().describe("Kintone代表者名と一致するか"),
      birthDateMatch: z.boolean().describe("Kintone生年月日と一致するか"),
    })).describe("抽出した人物情報（複数免許証対応）"),
    matchedPerson: z.object({
      name: z.string(),
      birthDate: z.string().optional(),
      address: z.string().optional(),
    }).optional().describe("Kintoneと一致した人物（1人でも一致すればこちらに格納）"),
    companyInfo: z.object({
      companyName: z.string().describe("抽出した会社名"),
      capital: z.string().optional().describe("資本金"),
      established: z.string().optional().describe("設立年月日"),
      representative: z.string().optional().describe("代表者名"),
      location: z.string().optional().describe("本店所在地"),
      companyNameMatch: z.boolean().describe("Kintone会社名と一致するか"),
    }).optional().describe("会社登記情報（登記簿謄本がある場合のみ）"),
    documentType: z.string().describe("書類の種類"),
    verificationResults: z.object({
      personCount: z.number().describe("検出された人数"),
      matchedPersonCount: z.number().describe("一致した人数"),
      hasCompanyInfo: z.boolean().describe("会社情報が含まれているか"),
      summary: z.string(),
    }),
    processingDetails: z.object({
      expectedName: z.string(),
      expectedBirthDate: z.string(),
      expectedCompanyName: z.string(),
    }),
    summary: z.string(),
  }),
  
  execute: async ({ context }) => {
    const { recordId, identityDocuments, model } = context;
    
    try {
      // 1. Kintoneから期待値（代表者名・生年月日）を取得
      const domain = process.env.KINTONE_DOMAIN;
      const apiToken = process.env.KINTONE_API_TOKEN;
      const appId = process.env.KINTONE_APP_ID || "37";
      
      if (!domain || !apiToken) {
        throw new Error("Kintone環境変数が設定されていません");
      }
      
      const url = `https://${domain}/k/v1/records.json?app=${appId}&query=$id="${recordId}"`;
      const response = await axios.get(url, {
        headers: { 'X-Cybozu-API-Token': apiToken },
      });
      
      if (response.data.records.length === 0) {
        throw new Error(`レコードID: ${recordId} が見つかりません`);
      }
      
      const record = response.data.records[0];
      const expectedName = record.代表者名?.value || "";
      const expectedBirthDate = record.生年月日?.value || "";
      const expectedCompanyName = record.屋号?.value || record.会社名?.value || "";
      
      console.log(`[Identity Verification] 期待値: 代表者名=${expectedName}, 生年月日=${expectedBirthDate}, 会社名=${expectedCompanyName}`);
      
      if (identityDocuments.length === 0) {
        return {
          success: false,
          persons: [],
          matchedPerson: undefined,
          companyInfo: undefined,
          documentType: "不明",
          verificationResults: {
            personCount: 0,
            matchedPersonCount: 0,
            hasCompanyInfo: false,
            summary: "本人確認書類が見つかりません",
          },
          processingDetails: {
            expectedName,
            expectedBirthDate,
            expectedCompanyName,
          },
          summary: "本人確認書類が見つかりません",
        };
      }
      
      // 2. 全ドキュメントのOCRテキストを結合
      const combinedText = identityDocuments
        .map(doc => doc.text)
        .join("\n\n=== 次のページ ===\n\n");
      
      console.log(`[Identity Verification] AI分析開始: ${combinedText.length}文字`);
      
      // 3. AIで構造化分析（複数人対応 + 会社情報）
      const analysisPrompt = `以下のOCRテキストから、情報を抽出してください。

【OCRテキスト】
${combinedText}

【抽出ルール】
まず書類の種類を判定してください：
- 本人確認書類（運転免許証、パスポート、マイナンバーカード、健康保険証など）
- 会社の登記情報（商業登記簿謄本、登記事項証明書など）

【本人確認書類の場合】
**重要: 複数人の免許証がある場合は、persons配列に1人ずつ格納してください**
1. 氏名を抽出（スペースを含む完全な氏名）
2. 生年月日を抽出（YYYY-MM-DD形式に変換、和暦なら西暦に変換）
3. 住所を抽出（番地・部屋番号まで含む完全な住所）

例: 免許証が2枚ある場合
persons: [
  { name: "山田太郎", birthDate: "1990-01-01", address: "東京都..." },
  { name: "山田花子", birthDate: "1995-05-05", address: "東京都..." }
]

【会社の登記情報の場合】
**登記簿謄本がある場合のみ、companyInfoを設定してください。ない場合はnullにしてください。**
1. 会社名を抽出（正式名称）
2. 資本金を抽出（金額と単位）
3. 設立年月日を抽出
4. 代表者名を抽出
5. 本店所在地を抽出

【注意】
- 見えない/判別不能な場合はnullを返す
- 推測や補完は禁止。OCRテキストで確認できるもののみ
- 和暦は西暦に変換（例：平成15年1月13日 → 2003-01-13）
- 複数人の免許証は必ず配列で分けて返す

JSON形式で出力してください。`;
      
      const result = await generateObject({
        model: openai(model),
        prompt: analysisPrompt,
        schema: z.object({
          persons: z.array(z.object({
            name: z.string().describe("抽出した氏名"),
            birthDate: z.string().nullable().describe("抽出した生年月日（YYYY-MM-DD形式）"),
            address: z.string().nullable().describe("抽出した住所"),
          })).describe("本人確認書類から抽出した人物情報（複数対応）"),
          companyInfo: z.object({
            companyName: z.string().describe("会社名"),
            capital: z.string().nullable().describe("資本金"),
            established: z.string().nullable().describe("設立年月日"),
            representative: z.string().nullable().describe("代表者名"),
            location: z.string().nullable().describe("本店所在地"),
          }).nullable().describe("登記情報（ある場合のみ、ない場合はnull）"),
          documentType: z.string().describe("書類の種類（例：運転免許証、登記簿謄本）"),
        }),
      });
      
      // 4. 各人物ごとにKintone照合
      const personsWithMatch = result.object.persons.map((person) => {
        const nameMatch = normalizeText(person.name) === normalizeText(expectedName);
        const birthDateMatch = person.birthDate === expectedBirthDate;
        
        return {
          name: person.name,
          birthDate: person.birthDate || undefined,
          address: person.address || undefined,
          nameMatch,
          birthDateMatch,
        };
      });
      
      console.log(`[Identity Verification] AI抽出結果: ${personsWithMatch.length}人検出`);
      personsWithMatch.forEach((person, idx) => {
        console.log(`  ${idx + 1}. ${person.name} (生年月日: ${person.birthDate || '不明'})`);
        console.log(`     氏名一致: ${person.nameMatch ? '✓' : '✗'}, 生年月日一致: ${person.birthDateMatch ? '✓' : '✗'}`);
      });
      
      // 5. 一致する人物を抽出（1人でも一致すればOK）
      const matchedPersons = personsWithMatch.filter(p => p.nameMatch && p.birthDateMatch);
      const matchedPerson = matchedPersons.length > 0 ? {
        name: matchedPersons[0].name,
        birthDate: matchedPersons[0].birthDate,
        address: matchedPersons[0].address,
      } : undefined;
      
      // 6. 会社情報の照合（ある場合のみ）
      let companyInfo: any = undefined;
      if (result.object.companyInfo) {
        const companyNameMatch = normalizeText(result.object.companyInfo.companyName) === normalizeText(expectedCompanyName);
        
        companyInfo = {
          companyName: result.object.companyInfo.companyName,
          capital: result.object.companyInfo.capital || undefined,
          established: result.object.companyInfo.established || undefined,
          representative: result.object.companyInfo.representative || undefined,
          location: result.object.companyInfo.location || undefined,
          companyNameMatch,
        };
        
        console.log(`[Identity Verification] 会社情報検出: ${companyInfo.companyName}`);
        console.log(`  会社名一致: ${companyNameMatch ? '✓' : '✗'}`);
        if (companyInfo.capital) console.log(`  資本金: ${companyInfo.capital}`);
        if (companyInfo.established) console.log(`  設立: ${companyInfo.established}`);
        if (companyInfo.representative) console.log(`  代表者: ${companyInfo.representative}`);
      }
      
      // 7. サマリー生成
      const summaryParts = [];
      
      if (matchedPersons.length > 0) {
        summaryParts.push(`✓ ${matchedPersons.length}/${personsWithMatch.length}人が一致`);
      } else {
        summaryParts.push(`✗ 全員不一致 (${personsWithMatch.length}人中0人)`);
      }
      
      if (companyInfo) {
        if (companyInfo.companyNameMatch) {
          summaryParts.push("✓ 会社名一致");
        } else {
          summaryParts.push("⚠️ 会社名不一致");
        }
        
        const importantInfo = [];
        if (companyInfo.capital) importantInfo.push(`資本金: ${companyInfo.capital}`);
        if (companyInfo.established) importantInfo.push(`設立: ${companyInfo.established}`);
        if (companyInfo.representative) importantInfo.push(`代表者: ${companyInfo.representative}`);
        
        if (importantInfo.length > 0) {
          summaryParts.push(`📊 ${importantInfo.join(', ')}`);
        }
      }
      
      const summary = summaryParts.join(' | ');
      console.log(`[Identity Verification] 最終判定: ${summary}`);
      
      return {
        success: matchedPersons.length > 0, // 1人でも一致すればtrue
        persons: personsWithMatch,
        matchedPerson,
        companyInfo,
        documentType: result.object.documentType,
        verificationResults: {
          personCount: personsWithMatch.length,
          matchedPersonCount: matchedPersons.length,
          hasCompanyInfo: companyInfo !== undefined,
          summary,
        },
        processingDetails: {
          expectedName,
          expectedBirthDate,
          expectedCompanyName,
        },
        summary,
      };
    } catch (error) {
      console.error("[Identity Verification] エラー:", error);
      return {
        success: false,
        persons: [],
        matchedPerson: undefined,
        companyInfo: undefined,
        documentType: "不明",
        verificationResults: {
          personCount: 0,
          matchedPersonCount: 0,
          hasCompanyInfo: false,
          summary: `エラー: ${error instanceof Error ? error.message : "不明なエラー"}`,
        },
        processingDetails: {
          expectedName: "",
          expectedBirthDate: "",
          expectedCompanyName: "",
        },
        summary: `エラー: ${error instanceof Error ? error.message : "不明なエラー"}`,
      };
    }
  },
});

/**
 * テキストの正規化（照合用）
 */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')          // スペース削除
    .replace(/[　]/g, '')         // 全角スペース削除
    .toLowerCase();
}

