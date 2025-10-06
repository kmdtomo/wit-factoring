import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";
import type { KintoneRecord } from "../types";

// Kintoneからレコードを取得するツール
export const kintoneFetchTool = createTool({
  id: "kintone-fetch-tool",
  description: "Kintoneからレコードを取得する",
  inputSchema: z.object({
    recordId: z.string().describe("取得するレコードID"),
  }),
  outputSchema: z.any(),
  
  execute: async ({ context }) => {
    const { recordId } = context;
    const domain = process.env.KINTONE_DOMAIN;
    const apiToken = process.env.KINTONE_API_TOKEN;
    const appId = process.env.KINTONE_APP_ID;
    
    if (!domain || !apiToken || !appId) {
      throw new Error("Kintone環境変数が設定されていません");
    }
    
    try {
      // レコード取得
      const url = `https://${domain}/k/v1/records.json?app=${appId}&query=$id="${recordId}"`;
      console.log(`[KintoneFetch] domain=${domain}, appId=${appId}, recordId=${recordId}`);
      console.log(`[KintoneFetch] GET ${url}`);
      const response = await axios.get(url, {
        headers: {
          'X-Cybozu-API-Token': apiToken,
        },
      });
      
      if (response.data.records.length === 0) {
        throw new Error(`レコードID: ${recordId} が見つかりません`);
      }
      
      const record = response.data.records[0];
      console.log(`[KintoneFetch] record keys: ${Object.keys(record).join(', ')}`);
      
      // デバッグ: すべてのフィールドキーを確認
      const fileRelatedKeys = Object.keys(record).filter(key => 
        key.includes('ファイル') || 
        key.includes('添付') || 
        key.includes('通帳') || 
        key.includes('買取') ||
        key.includes('file') ||
        key.includes('File')
      );
      console.log(`[KintoneFetch] ファイル関連フィールド:`, fileRelatedKeys);
      
      // 各フィールドの内容を確認
      fileRelatedKeys.forEach(key => {
        const field = record[key];
        if (field && field.value) {
          console.log(`[KintoneFetch] ${key}:`, {
            type: field.type,
            valueType: Array.isArray(field.value) ? 'array' : typeof field.value,
            length: Array.isArray(field.value) ? field.value.length : undefined,
            sample: Array.isArray(field.value) && field.value.length > 0 ? field.value[0] : field.value
          });
        }
      });
      
      // Kintone形式からアプリ形式に変換
      
      const kintoneRecord: KintoneRecord = {
        recordId,
        basic: {
          顧客番号: record.顧客番号?.value || "",
          会社_屋号名: record.屋号?.value || "",
          代表者名: record.代表者名?.value || "",
          生年月日: record.生年月日?.value || "",
          携帯番号_ハイフンなし: record.携帯番号_ハイフンなし?.value || "",
          会社所在地: record.会社所在地?.value || "",
          自宅所在地: record.自宅所在地?.value || "",
        },
        financialRisk: {
          売上: Number(record.売上?.value || 0),
          業種: record.業種?.value || "",
          資金使途: record.資金使途?.value || "",
          ファクタリング利用: record.ファクタリング利用?.value || "",
          税金滞納額_0: Number(record.税金滞納額_0?.value || 0),
          納付状況_税金: record.納付状況_税金?.value || "",
          保険料滞納額: Number(record.保険料滞納額?.value || 0),
          納付状況_保険料: record.納付状況_保険料?.value || "",
        },
        purchases: record.買取情報?.value?.map((row: any) => ({
          会社名_第三債務者_買取: row.value.会社名_第三債務者_買取?.value || "",
          総債権額: Number(row.value.総債権額?.value || 0),
          買取債権額: Number(row.value.買取債権額?.value || 0),
          買取額: Number(row.value.買取額?.value || 0),
          掛目: row.value.掛目?.value || "",
          買取債権支払日: row.value.買取債権支払日?.value || "",
          状態_0: row.value.状態_0?.value || "",
        })) || [],
        collaterals: record.担保情報?.value?.map((row: any) => ({
          会社名_第三債務者_担保: row.value.会社名_第三債務者_担保?.value || "",
          請求額: Number(row.value.請求額?.value || 0),
          入金予定日: row.value.入金予定日?.value || "",
          過去の入金_先々月: Number(row.value.過去の入金_先々月?.value || 0),
          過去の入金_先月: Number(row.value.過去の入金_先月?.value || 0),
          過去の入金_今月: Number(row.value.過去の入金_今月?.value || 0),
          平均: Number(row.value.平均?.value || 0),
          備考: row.value.備考?.value || row.value.備考_担保?.value || "",
        })) || [],
        registries: (record.謄本情報_営業?.value || record.謄本情報?.value)?.map((row: any) => ({
          会社名_第三債務者_0: row.value.会社名_第三債務者_0?.value || "",
          資本金の額: row.value.資本金の額?.value || "",
          会社成立: row.value.会社成立?.value || "",
          債権の種類: row.value.債権の種類?.value || "",
        })) || [],
        recovery: record.回収情報?.value?.map((row: any) => ({
          回収予定日: row.value.回収予定日?.value || "",
          回収金額: Number(row.value.回収金額?.value || 0),
        })) || [],
        fundUsage: {
          所感_条件_担当者: record.所感_条件_担当者?.value || "",
          所感_条件_決裁者: record.所感_条件_決裁者?.value || "",
          留意事項_営業: record.留意事項_営業?.value || "",
          留意事項_審査: record.留意事項_審査?.value || "",
        },
        attachments: {
          買取情報_成因証書_謄本類_名刺等_添付ファイル: record.成因証書＿添付ファイル?.value || [],
          通帳_メイン_添付ファイル: record.メイン通帳＿添付ファイル?.value || [],
          通帳_その他_添付ファイル: record.その他通帳＿添付ファイル?.value || [],
          顧客情報_添付ファイル: record.顧客情報＿添付ファイル?.value || [],
          他社資料_添付ファイル: record.他社資料＿添付ファイル?.value || [],
          担保情報_成因証書_謄本類_名刺等_添付ファイル: record.担保情報＿添付ファイル?.value || [],
          その他_添付ファイル: record.その他＿添付ファイル?.value || [],
        },
      };
      
      // 添付ファイルのfileKeyを収集
      const fileKeys: any[] = [];
      Object.entries(kintoneRecord.attachments).forEach(([category, files]) => {
        if (Array.isArray(files) && files.length > 0) {
          files.forEach((file: any) => {
            fileKeys.push({
              fileKey: file.fileKey,
              name: file.name,
              contentType: file.contentType,
              size: file.size,
              category: category
            });
          });
        }
      });
      
      console.log(`[KintoneFetch] Found ${fileKeys.length} files`);
      
      // 合計値の追加
      const purchaseSummary = {
        買取債権額_合計: Number(record.買取債権額_合計?.value || 0) || 
          kintoneRecord.purchases.reduce((sum: number, p: any) => sum + p.買取債権額, 0),
        買取額_合計: Number(record.買取額_合計?.value || 0) ||
          kintoneRecord.purchases.reduce((sum: number, p: any) => sum + p.買取額, 0),
      };
      
      return {
        success: true,
        record: kintoneRecord,
        purchaseSummary,
        fileKeys,
        message: `レコードID: ${recordId} を取得しました（ファイル: ${fileKeys.length}件）`,
      };
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "不明なエラー",
      };
    }
  },
});