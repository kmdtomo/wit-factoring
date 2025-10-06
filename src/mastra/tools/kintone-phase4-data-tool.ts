import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from "axios";

// Phase 4で必要な全Kintoneデータを取得するツール
export const kintonePhase4DataTool = createTool({
  id: "kintone-phase4-data-tool",
  description: "Phase 4審査レポート生成に必要な全Kintoneデータを取得する",
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
      console.log(`[KintonePhase4Data] Fetching record ${recordId}`);

      const response = await axios.get(url, {
        headers: {
          'X-Cybozu-API-Token': apiToken,
        },
      });

      if (response.data.records.length === 0) {
        throw new Error(`レコードID: ${recordId} が見つかりません`);
      }

      const record = response.data.records[0];

      // 基本情報テーブル
      const 基本情報 = {
        顧客番号: record.顧客番号?.value || "",
        種別: record.種別?.value || "",
        屋号: record.屋号?.value || "",
        会社名: record.会社名?.value || "",
        代表者名: record.代表者名?.value || "",
        生年月日: record.生年月日?.value || "",
        年齢: record.年齢?.value || "",
        携帯番号: record.携帯番号_ハイフンなし?.value || "",
        自宅所在地: record.自宅所在地?.value || "",
        会社所在地: record.会社所在地?.value || "",
        入金日: record.入金日?.value || "",
        設立年: record.設立年?.value || "",
        業種: record.業種?.value || "",
        売上: record.売上?.value || "",
        年商: record.年商?.value || "",
      };

      // 財務・リスク情報
      const 財務リスク情報 = {
        資金使途: record.資金使途?.value || "",
        ファクタリング利用: record.ファクタリング利用?.value || "",
        納付状況_税金: record.納付状況_税金?.value || "",
        税金滞納額: record.税金滞納額_0?.value || "",
        納付状況_保険料: record.納付状況_保険料?.value || "",
        保険料滞納額: record.保険料滞納額?.value || "",
      };

      // 買取情報テーブル
      const 買取情報 = (record.買取情報?.value || []).map((row: any) => ({
        買取先企業名: row.value.会社名_第三債務者_買取?.value || "",
        総債権額: row.value.総債権額?.value || "",
        買取債権額: row.value.買取債権額?.value || "",
        買取額: row.value.買取額?.value || "",
        掛目: row.value.掛目?.value || "",
        粗利額: row.value.粗利額?.value || "",
        粗利率: row.value.粗利率?.value || "",
        買取債権支払日: row.value.買取債権支払日?.value || "",
        状態: row.value.状態_0?.value || "",
        再契約の意思: row.value.再契約の意思?.value || "",
        再契約時買取債権額: row.value.再契約時買取債権額?.value || "",
        再契約時買取額: row.value.再契約時買取額?.value || "",
        再契約時粗利額: row.value.再契約時粗利額?.value || "",
        再契約粗利率: row.value.再契約粗利率?.value || "",
      }));

      // 担保情報テーブル
      const 担保情報 = (record.担保情報?.value || []).map((row: any) => ({
        担保企業名: row.value.会社名_第三債務者_担保?.value || "",
        次回入金予定額: row.value.請求額?.value || "",
        入金予定日: row.value.入金予定日?.value || "",
        過去の入金_先々月: row.value.過去の入金_先々月?.value || "",
        過去の入金_先月: row.value.過去の入金_先月?.value || "",
        過去の入金_今月: row.value.過去の入金_今月?.value || "",
        平均: row.value.平均?.value || "",
        備考: row.value.備考?.value || row.value.備考_担保?.value || "",
      }));

      // 謄本情報テーブル
      const 謄本情報 = (record.謄本情報_営業?.value || record.謄本情報?.value || []).map((row: any) => ({
        会社名: row.value.会社名_第三債務者_0?.value || "",
        資本金の額: row.value.資本金の額?.value || "",
        会社成立_元号: row.value.会社成立?.value || "",
        会社成立_年: row.value.年?.value || "",
        債権の種類: row.value.債権の種類?.value || "",
        最終登記取得日: row.value.最終登記取得日?.value || "",
      }));

      // 期待値テーブル（通帳照合用）
      const 期待値 = (record.期待値?.value || []).map((row: any) => ({
        企業名: row.value.企業名?.value || "",
        月: row.value.月?.value || "",
        期待額: row.value.期待額?.value || "",
      }));

      // 回収情報テーブル
      const 回収情報 = (record.回収情報?.value || []).map((row: any) => ({
        回収予定日: row.value.回収予定日?.value || "",
        回収金額: row.value.回収金額?.value || "",
      }));

      const kintoneData = {
        recordId,
        基本情報,
        財務リスク情報,
        買取情報,
        担保情報,
        謄本情報,
        期待値,
        回収情報,
      };

      console.log(`[KintonePhase4Data] 取得完了:`, {
        基本情報: Object.keys(基本情報).length,
        買取情報: 買取情報.length,
        担保情報: 担保情報.length,
        謄本情報: 謄本情報.length,
        期待値: 期待値.length,
      });

      return {
        success: true,
        data: kintoneData,
        message: `レコードID: ${recordId} のKintoneデータを取得しました`,
      };

    } catch (error) {
      console.error(`[KintonePhase4Data] エラー:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "不明なエラー",
      };
    }
  },
});
