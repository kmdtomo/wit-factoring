import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import { ImageAnnotatorClient } from '@google-cloud/vision';
import path from 'path';

// Google Cloud認証設定
let visionClient: ImageAnnotatorClient;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  // JSON文字列から認証情報を読み込む（本番環境用）
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  visionClient = new ImageAnnotatorClient({ credentials });
} else {
  // ファイルパスから読み込む（ローカル環境用）
  const authPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (authPath && !path.isAbsolute(authPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(process.cwd(), authPath);
  }
  visionClient = new ImageAnnotatorClient();
}

// 環境変数は実行時に取得するように変更
const getKintoneConfig = () => ({
  KINTONE_DOMAIN: process.env.KINTONE_DOMAIN || "",
  KINTONE_API_TOKEN: process.env.KINTONE_API_TOKEN || "",
  APP_ID: process.env.KINTONE_APP_ID || "37"
});

export const googleVisionIdentityOcrTool = createTool({
  id: "google-vision-identity-ocr",
  description: "本人確認書類をGoogle Vision APIでOCR処理するツール",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    identityFieldName: z.string().describe("本人確認書類のフィールド名").default("顧客情報＿添付ファイル"),
    maxPagesPerFile: z.number().describe("1ファイルあたりの最大処理ページ数").default(10),
  }).describe("Google Vision OCR処理の入力パラメータ"),
  
  outputSchema: z.object({
    success: z.boolean(),
    processingDetails: z.object({
      recordId: z.string(),
      processedFiles: z.number(),
      totalPages: z.number(),
      timestamp: z.string(),
    }).describe("処理詳細情報"),
    identityDocuments: z.array(z.object({
      fileName: z.string().describe("ファイル名"),
      text: z.string().describe("抽出されたテキスト"),
      pageCount: z.number().describe("ページ数"),
      confidence: z.number().describe("信頼度"),
      tokenEstimate: z.number().describe("推定トークン数"),
    })).describe("本人確認書類ドキュメントリスト"),
    costAnalysis: z.object({
      googleVisionCost: z.number(),
    }).describe("コスト分析"),
    error: z.string().optional(),
  }).describe("Google Vision OCR処理の出力結果"),
  
  execute: async ({ context }) => {
    const { recordId, identityFieldName, maxPagesPerFile } = context;
    const timestamp = new Date().toISOString();
    
    // 環境変数のチェック
    const { KINTONE_DOMAIN, KINTONE_API_TOKEN, APP_ID } = getKintoneConfig();
    if (!KINTONE_DOMAIN || !KINTONE_API_TOKEN) {
      throw new Error("Kintone環境変数が設定されていません");
    }
    
    try {
      // 1. KintoneからレコードIDをもとに情報を取得
      const recordUrl = `https://${KINTONE_DOMAIN}/k/v1/records.json?app=${APP_ID}&query=$id="${recordId}"`;
      
      const recordResponse = await axios.get(recordUrl, {
        headers: {
          "X-Cybozu-API-Token": KINTONE_API_TOKEN,
        },
      });
      
      if (recordResponse.data.records.length === 0) {
        return {
          success: false,
          processingDetails: {
            recordId,
            processedFiles: 0,
            totalPages: 0,
            timestamp,
          },
          identityDocuments: [],
          costAnalysis: {
            googleVisionCost: 0,
          },
          error: `レコードID ${recordId} が見つかりません`,
        };
      }
      
      const record = recordResponse.data.records[0];
      const identityFiles = record[identityFieldName]?.value || [];
      
      if (identityFiles.length === 0) {
        return {
          success: false,
          processingDetails: {
            recordId,
            processedFiles: 0,
            totalPages: 0,
            timestamp,
          },
          identityDocuments: [],
          costAnalysis: {
            googleVisionCost: 0,
          },
          error: `${identityFieldName} にファイルが添付されていません`,
        };
      }
      
      console.log(`[Google Vision Identity OCR] 処理開始: ${identityFiles.length}ファイル`);
      
      // 2. 本人確認書類をOCR処理
      const identityDocuments = [];
      let totalPages = 0;
      
      for (const file of identityFiles) {
        console.log(`[Google Vision Identity OCR] 処理中: ${file.name}`);
        
        try {
          // ファイルをダウンロード
          const downloadUrl = `https://${KINTONE_DOMAIN}/k/v1/file.json?fileKey=${file.fileKey}`;
          const fileResponse = await axios.get(downloadUrl, {
            headers: {
              "X-Cybozu-API-Token": KINTONE_API_TOKEN,
            },
            responseType: 'arraybuffer',
          });
          
          const fileBuffer = Buffer.from(fileResponse.data);
          
          // Google Vision APIでOCR処理
          const [result] = await visionClient.documentTextDetection({
            image: { content: fileBuffer },
          });
          
          const fullTextAnnotation = result.fullTextAnnotation;
          const text = fullTextAnnotation?.text || "";
          const confidence = fullTextAnnotation?.pages?.[0]?.confidence || 0;
          const pageCount = fullTextAnnotation?.pages?.length || 1;
          
          totalPages += pageCount;
          
          // トークン数の推定（約4文字=1トークン）
          const tokenEstimate = Math.ceil(text.length / 4);
          
          identityDocuments.push({
            fileName: file.name,
            text,
            pageCount,
            confidence,
            tokenEstimate,
          });
          
          console.log(`[Google Vision Identity OCR] 完了: ${file.name} (${pageCount}ページ, ${text.length}文字)`);
        } catch (error) {
          console.error(`[Google Vision Identity OCR] エラー: ${file.name}`, error);
          // エラーが発生しても他のファイルは処理を続ける
          identityDocuments.push({
            fileName: file.name,
            text: `[OCRエラー: ${error instanceof Error ? error.message : "不明なエラー"}]`,
            pageCount: 0,
            confidence: 0,
            tokenEstimate: 0,
          });
        }
      }
      
      // 3. コスト計算（Google Vision API: $1.50 per 1000 pages）
      const googleVisionCost = (totalPages / 1000) * 1.5;
      
      console.log(`[Google Vision Identity OCR] 処理完了: ${identityDocuments.length}ファイル, ${totalPages}ページ, コスト: $${googleVisionCost.toFixed(4)}`);
      
      return {
        success: identityDocuments.length > 0,
        processingDetails: {
          recordId,
          processedFiles: identityDocuments.length,
          totalPages,
          timestamp,
        },
        identityDocuments,
        costAnalysis: {
          googleVisionCost,
        },
      };
    } catch (error) {
      console.error("[Google Vision Identity OCR] 予期しないエラー:", error);
      return {
        success: false,
        processingDetails: {
          recordId,
          processedFiles: 0,
          totalPages: 0,
          timestamp,
        },
        identityDocuments: [],
        costAnalysis: {
          googleVisionCost: 0,
        },
        error: error instanceof Error ? error.message : "不明なエラー",
      };
    }
  },
});

