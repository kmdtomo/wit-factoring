import { createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import axios from "axios";
import { googleVisionIdentityOcrTool } from "../tools/google-vision-identity-ocr-tool";
import { identityVerificationTool } from "../tools/identity-verification-tool";
import { egoSearchTool } from "../tools/ego-search-tool";
import { companyVerifyBatchTool } from "../tools/company-verify-batch-tool";

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

/**
 * Phase 3: 本人確認・企業実在性確認ステップ
 * エージェントを使わず、ワークフロー内でツールを直接実行
 */
export const phase3VerificationStep = createStep({
  id: "phase3-verification",
  description: "本人確認・企業実在性確認（本人確認OCR → エゴサーチ → 企業検証 → 代表者リスク検索）",
  
  inputSchema: z.object({
    recordId: z.string().describe("KintoneレコードID"),
    phase1Results: z.any().optional().describe("Phase 1の結果（買取・担保情報）"),
    phase2Results: z.any().optional().describe("Phase 2の結果（通帳分析）"),
  }),
  
  outputSchema: z.object({
    recordId: z.string(),
    phase1Results: z.any().optional().describe("Phase 1の結果（引き継ぎ）"),
    phase2Results: z.any().optional().describe("Phase 2の結果（引き継ぎ）"),
    phase3Results: z.object({
      本人確認: z.object({
        書類タイプ: z.string(),
        照合結果: z.string(),
        検出人数: z.number(),
        一致人数: z.number(),
        一致人物: z.object({
          氏名: z.string(),
          生年月日: z.string(),
          住所: z.string(),
        }).optional(),
        会社情報: z.object({
          会社名: z.string(),
          会社名照合: z.string(),
          資本金: z.string(),
          設立年月日: z.string(),
          代表者名: z.string(),
          本店所在地: z.string(),
        }).optional(),
      }),
      申込者エゴサーチ: z.object({
        ネガティブ情報: z.boolean(),
        詐欺情報サイト: z.number(),
        Web検索: z.number(),
        詳細: z.string(),
        ネガティブURL一覧: z.array(z.object({
          タイトル: z.string(),
          URL: z.string(),
          ソース: z.string().describe("詐欺情報サイト or Web検索(クエリ名)"),
        })).optional().describe("ネガティブ情報が見つかった全てのURL"),
      }),
      企業実在性: z.object({
        申込企業: z.object({
          企業名: z.string(),
          公式サイト: z.string(),
          確認方法: z.string(),
          確認元URL: z.string().optional(),
          信頼度: z.number(),
        }).optional(),
        買取企業: z.object({
          総数: z.number(),
          確認済み: z.number(),
          未確認: z.number(),
          企業リスト: z.array(z.object({
            企業名: z.string(),
            公式サイト: z.string(),
            確認方法: z.string(),
            確認元URL: z.string().optional(),
            信頼度: z.number(),
          })),
        }),
        担保企業: z.object({
          総数: z.number(),
          確認済み: z.number(),
          未確認: z.number(),
          備考: z.string().optional(),
          企業リスト: z.array(z.object({
            企業名: z.string(),
            公式サイト: z.string(),
            確認方法: z.string(),
            確認元URL: z.string().optional(),
            信頼度: z.number(),
          })),
        }),
      }),
      代表者リスク: z.object({
        検索対象: z.number(),
        リスク検出: z.number(),
        リスク詳細: z.array(z.object({
          氏名: z.string(),
          会社: z.string(),
          企業種別: z.string(),
          ネガティブ情報: z.boolean(),
          詐欺情報サイト: z.number(),
          Web検索: z.number(),
        })).optional(),
      }),
      処理時間: z.string(),
    }),
  }),
  
  execute: async ({ inputData }) => {
    const { recordId, phase1Results, phase2Results } = inputData;
    
    const startTime = Date.now();
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🚀 [Phase 3] 本人確認・企業実在性確認 開始`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Record ID: ${recordId}`);
    
    // ========================================
    // Step 1-1: Google Vision OCR処理
    // ========================================
    console.log(`\n━━━ Step 1-1: Google Vision OCR処理 ━━━`);
    const ocrStartTime = Date.now();

    const ocrResult = await googleVisionIdentityOcrTool.execute!({
      context: {
        recordId,
        identityFieldName: "顧客情報＿添付ファイル",
        maxPagesPerFile: 10,
      },
      runtimeContext: new RuntimeContext(),
    });

    const ocrDuration = Date.now() - ocrStartTime;
    console.log(`OCR処理完了 - 処理時間: ${ocrDuration}ms`);
    console.log(`  - 本人確認書類: ${ocrResult.identityDocuments.length}件`);
    console.log(`  - 総ページ数: ${ocrResult.processingDetails.totalPages}ページ`);

    let identityResult: any = null;

    if (ocrResult.identityDocuments.length > 0) {
      console.log(`\n【本人確認書類】`);
      ocrResult.identityDocuments.forEach((doc, index) => {
        console.log(`  📄 ${doc.fileName} (${doc.pageCount}ページ)`);
        console.log(`     先頭: "${doc.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
      });

      // ========================================
      // Step 1-2: 本人確認検証（AI分析 + 照合）
      // ========================================
      console.log(`\n━━━ Step 1-2: 本人確認検証 ━━━`);
      const verificationStartTime = Date.now();

      identityResult = await identityVerificationTool.execute!({
        context: {
          recordId,
          identityDocuments: ocrResult.identityDocuments,
          model: "gemini-2.5-flash",
        },
        runtimeContext: new RuntimeContext(),
      });

      const verificationDuration = Date.now() - verificationStartTime;
      console.log(`本人確認検証完了 - 処理時間: ${verificationDuration}ms`);

      console.log(`\n【書類タイプ】`);
      console.log(`  ${identityResult.documentType}`);

      console.log(`\n【検出結果】`);
      console.log(`  検出人数: ${identityResult.verificationResults?.personCount || 0}人`);
      console.log(`  一致人数: ${identityResult.verificationResults?.matchedPersonCount || 0}人`);

      if (identityResult.persons && identityResult.persons.length > 0) {
        console.log(`\n【検出された人物】`);
        identityResult.persons.forEach((person: any, idx: number) => {
          if (person && person.name) {
            const icon = person.nameMatch && person.birthDateMatch ? "✓" : "✗";
            console.log(`  ${icon} ${idx + 1}. ${person.name}`);
            console.log(`     生年月日: ${person.birthDate || "不明"}`);
            console.log(`     住所: ${person.address || "不明"}`);
            console.log(`     判定: 氏名${person.nameMatch ? "○" : "×"} / 生年月日${person.birthDateMatch ? "○" : "×"}`);
          }
        });
      } else {
        console.log(`\n⚠️  人物情報が検出されませんでした`);
      }

      if (identityResult.matchedPerson && identityResult.matchedPerson.name) {
        console.log(`\n【一致した人物】`);
        console.log(`  ✓ 氏名: ${identityResult.matchedPerson.name}`);
        console.log(`  ✓ 生年月日: ${identityResult.matchedPerson.birthDate || "不明"}`);
        console.log(`  ✓ 住所: ${identityResult.matchedPerson.address || "不明"}（参考情報）`);
      } else {
        console.log(`\n⚠️  一致する人物が見つかりませんでした`);
      }

      if (identityResult.companyInfo && identityResult.companyInfo.companyName) {
        console.log(`\n【会社情報】`);
        console.log(`  会社名: ${identityResult.companyInfo.companyName}`);
        console.log(`  照合: ${identityResult.companyInfo.companyNameMatch ? "✓ 一致" : "✗ 不一致"}`);
        if (identityResult.companyInfo.capital) console.log(`  資本金: ${identityResult.companyInfo.capital}`);
        if (identityResult.companyInfo.established) console.log(`  設立: ${identityResult.companyInfo.established}`);
        if (identityResult.companyInfo.representative) console.log(`  代表者: ${identityResult.companyInfo.representative}`);
        if (identityResult.companyInfo.location) console.log(`  本店: ${identityResult.companyInfo.location}`);
      } else {
        console.log(`\n  会社情報: なし`);
      }

      console.log(`\n【最終判定】`);
      console.log(`  ${identityResult.verificationResults?.summary || identityResult.summary}`);
    } else {
      console.log(`\n【本人確認書類】 ⚠️ ファイルなし - 本人確認検証をスキップします`);
    }
    
    // ========================================
    // Step 2: 申込者のエゴサーチ
    // ========================================
    console.log(`\n━━━ Step 2: 申込者のエゴサーチ ━━━`);

    const applicantEgoSearch = await egoSearchTool.execute!({
      context: { recordId },
      runtimeContext: new RuntimeContext(),
    });

    if (identityResult) {
      console.log(`\n対象: ${identityResult.processingDetails.expectedName || "不明"}（生年月日: ${identityResult.processingDetails.expectedBirthDate || "不明"}）`);
    } else {
      // Kintoneから申込者情報を取得して表示
      const applicantName = await fetchApplicantNameFromKintone(recordId);
      console.log(`\n対象: ${applicantName || "不明"}（本人確認書類なし - Kintone情報から検索）`);
    }
    
    console.log(`\n【詐欺情報サイト】`);
    for (const result of applicantEgoSearch.fraudSiteResults) {
      if (result.found) {
        console.log(`  ⚠️ ${result.siteName}: 該当あり`);
        if (result.details) {
          console.log(`     詳細: ${result.details}`);
        }
      } else {
        console.log(`  ✓ ${result.siteName}: 該当なし`);
      }
    }
    
    console.log(`\n【Web検索】`);
    for (const result of applicantEgoSearch.negativeSearchResults) {
      if (result.found && result.results && result.results.length > 0) {
        console.log(`\n  "${result.query}": ${result.results.length}件`);
        result.results.forEach((r: any, idx: number) => {
          console.log(`    ${idx + 1}. ${r.title}`);
          console.log(`       URL: ${r.url}`);
          console.log(`       ${r.snippet}`);
        });
      } else {
        console.log(`\n  "${result.query}": 0件`);
      }
    }

    // 申込者名を取得（本人確認結果 or Kintone）
    const applicantName = identityResult
      ? identityResult.processingDetails.expectedName
      : await fetchApplicantNameFromKintone(recordId);

    // AI判定は後でまとめて実行
    
    // ========================================
    // Step 3: 企業実在性確認（一括検証）
    // ========================================
    console.log(`\n━━━ Step 3: 企業実在性確認 ━━━`);

    // 全企業情報を収集
    const allCompanies: Array<{ name: string; type: "申込企業" | "買取企業" | "担保企業"; location?: string }> = [];

    // 申込企業
    console.log(`\n【申込企業】`);
    const applicantInfo = await fetchApplicantCompanyFromKintone(recordId);
    if (applicantInfo.companyName) {
      console.log(`  企業名: ${applicantInfo.companyName}`);
      if (applicantInfo.location) {
        console.log(`  所在地: ${applicantInfo.location}`);
      }
      allCompanies.push({
        name: applicantInfo.companyName,
        type: "申込企業",
        location: applicantInfo.location,
      });
    } else {
      console.log(`  ⚠️ 申込企業名が取得できませんでした（屋号・会社名フィールドが空）`);
    }

    // 買取企業
    if (phase1Results?.purchaseVerification?.purchaseInfo?.debtorCompanies?.length > 0) {
      console.log(`\n【買取企業】`);
      const purchaseInfo = phase1Results.purchaseVerification.purchaseInfo;
      purchaseInfo.debtorCompanies.forEach((company: any) => {
        console.log(`  企業名: ${company.name}`);
        allCompanies.push({
          name: company.name,
          type: "買取企業",
          location: undefined,
        });
      });
    } else {
      console.log(`\n【買取企業】`);
      console.log(`  ⚠️ Phase 1の結果がないため、買取企業情報を取得できません`);
    }

    // 担保企業
    console.log(`\n【担保企業】`);
    console.log(`  担保情報テーブルから企業名を取得中...`);
    const collateralCompanies = await fetchCollateralCompaniesFromKintone(recordId);
    if (collateralCompanies.length > 0) {
      console.log(`  取得: ${collateralCompanies.length}社`);
      collateralCompanies.forEach((company: any) => {
        console.log(`  企業名: ${company.name}`);
        allCompanies.push({
          name: company.name,
          type: "担保企業",
          location: undefined,
        });
      });
    } else {
      console.log(`  ⚠️ 担保企業情報なし（担保テーブルが空）`);
    }

    // 全企業の検索を実行（AI判定なし）
    console.log(`\n全${allCompanies.length}社の検索を実行中...`);
    const companySearchResult = await companyVerifyBatchTool.execute!({
      context: { companies: allCompanies },
      runtimeContext: new RuntimeContext(),
    });

    console.log(`検索完了 - ${companySearchResult.companies.length}社`);

    // 企業検索結果の詳細を表示
    console.log(`\n【企業検索結果の詳細】`);
    for (const company of companySearchResult.companies) {
      console.log(`\n  ${company.companyName}（${company.companyType}）:`);
      if (company.location) {
        console.log(`  所在地: ${company.location}`);
      }

      // 全検索クエリの結果を表示
      for (const searchResult of company.searchResults) {
        if (searchResult.results && searchResult.results.length > 0) {
          console.log(`\n    "${searchResult.query}": ${searchResult.results.length}件`);
          searchResult.results.forEach((r: any, idx: number) => {
            console.log(`      ${idx + 1}. ${r.title}`);
            console.log(`         URL: ${r.url}`);
            console.log(`         ${r.snippet}`);
          });
        } else {
          console.log(`\n    "${searchResult.query}": 0件`);
        }
      }
    }

    // ========================================
    // Step 4: 代表者リスク検索（並列実行）
    // ========================================
    console.log(`\n━━━ Step 4: 代表者リスク検索 ━━━`);
    console.log(`\n代表者情報はPhase 1の担保検証結果（謄本）からのみ取得`);
    
    const representatives: Array<{ name: string; company: string; type: string }> = [];

    // 買取企業の代表者は取得しない（一括検証では代表者情報を抽出していないため）
    // 代表者情報はPhase 1の担保検証結果（謄本）からのみ取得
    
    // 担保企業の代表者（Phase 1の担保検証結果からのみ取得）
    // 注意: 担保謄本ファイルがない場合、代表者情報は取得できない
    if (phase1Results?.collateralVerification?.collateralInfo?.companies) {
      console.log(`  Phase 1の担保検証結果から代表者を取得中...`);
      for (const company of phase1Results.collateralVerification.collateralInfo.companies) {
        if (company.representatives?.length > 0) {
          representatives.push({
            name: company.representatives[0],
            company: company.name,
            type: "担保企業",
          });
        }
      }
      console.log(`  取得: ${phase1Results.collateralVerification.collateralInfo.companies.filter((c: any) => c.representatives?.length > 0).length}名`);
    } else {
      console.log(`  ⚠️ Phase 1の担保検証結果がないため、代表者情報を取得できません`);
      console.log(`     （担保謄本ファイルがアップロードされていない可能性）`);
    }
    
    let representativeEgoSearches: any[] = [];

    if (representatives.length > 0) {
      console.log(`\n検索対象: ${representatives.length}名`);

      representativeEgoSearches = await Promise.all(
        representatives.map(async (rep) => {
          const result = await egoSearchTool.execute!({
            context: { name: rep.name },
            runtimeContext: new RuntimeContext(),
          });

          console.log(`  ${rep.name}（${rep.company}）: 検索完了`);
          return { ...rep, egoSearchResult: result };
        })
      );
    } else {
      console.log(`\n  代表者情報が取得できませんでした`);
    }

    // ========================================
    // Step 6: 全データのAI分析（1回のAI呼び出し）
    // ========================================
    console.log(`\n━━━ Step 6: エゴサーチ＋企業検証 AI分析 ━━━`);

    // 全員のエゴサーチデータを収集
    const allEgoSearchData = [
      {
        personType: "申込者",
        name: applicantName,
        company: undefined,
        companyType: undefined,
        egoSearchResult: applicantEgoSearch,
      },
      ...representativeEgoSearches.map(rep => ({
        personType: "代表者",
        name: rep.name,
        company: rep.company,
        companyType: rep.type,
        egoSearchResult: rep.egoSearchResult,
      })),
    ];

    console.log(`\n分析対象:`);
    console.log(`  - エゴサーチ: ${allEgoSearchData.length}名（申込者1名 + 代表者${representativeEgoSearches.length}名）`);
    console.log(`  - 企業検証: ${companySearchResult.companies.length}社`);

    // 1回のAI呼び出しで全データを分析
    console.log(`\nAI分析中... (gemini-2.5-flash)`);
    const aiAnalysisStartTime = Date.now();
    const analysisResults = await analyzeAllData(allEgoSearchData, companySearchResult.companies);
    const aiAnalysisDuration = Date.now() - aiAnalysisStartTime;
    console.log(`AI分析完了 - 処理時間: ${aiAnalysisDuration}ms`);

    // エゴサーチ結果を更新
    const applicantAnalysis = analysisResults.egoSearchAnalysis.persons.find(p => p.personIndex === 0);
    if (applicantAnalysis) {
      updateEgoSearchWithAnalysis(applicantEgoSearch, applicantAnalysis, applicantName);
    }

    for (let i = 0; i < representativeEgoSearches.length; i++) {
      const repAnalysis = analysisResults.egoSearchAnalysis.persons.find(p => p.personIndex === i + 1);
      if (repAnalysis) {
        updateEgoSearchWithAnalysis(representativeEgoSearches[i].egoSearchResult, repAnalysis, representativeEgoSearches[i].name);
      }
    }

    // 企業検証結果を生成
    const companyVerificationResults = companySearchResult.companies.map((company: any) => {
      const analysis = analysisResults.companyAnalysis.companies.find((c: any) => c.companyIndex === company.companyIndex);

      if (!analysis) {
        return {
          companyName: company.companyName,
          companyType: company.companyType,
          verified: false,
          confidence: 0,
          websiteUrl: null,
          verificationUrl: null,
          verificationSource: "未確認" as const,
          businessDescription: null,
          capital: null,
          established: null,
        };
      }

      return {
        companyName: company.companyName,
        companyType: company.companyType,
        verified: analysis.verified,
        confidence: analysis.confidence,
        websiteUrl: analysis.websiteUrl,
        verificationUrl: analysis.verificationUrl,
        verificationSource: analysis.verificationSource || "未確認",
        businessDescription: analysis.businessDescription,
        capital: analysis.capital,
        established: analysis.established,
      };
    });

    // 結果を種別ごとに分類
    const applicantCompany = companyVerificationResults.find(r => r.companyType === "申込企業");
    const purchaseCompanyResults = companyVerificationResults.filter(r => r.companyType === "買取企業");
    const collateralCompanyResults = companyVerificationResults.filter(r => r.companyType === "担保企業");

    // 結果表示
    console.log(`\n【申込者エゴサーチ結果】`);
    printEgoSearchResult(applicantName, undefined, applicantEgoSearch);

    if (representativeEgoSearches.length > 0) {
      const purchaseReps = representativeEgoSearches.filter(r => r.type === "買取企業");
      if (purchaseReps.length > 0) {
        console.log(`\n【買取企業代表者】`);
        for (const rep of purchaseReps) {
          printEgoSearchResult(rep.name, rep.company, rep.egoSearchResult);
        }
      }

      const collateralReps = representativeEgoSearches.filter(r => r.type === "担保企業");
      if (collateralReps.length > 0) {
        console.log(`\n【担保企業代表者】`);
        for (const rep of collateralReps) {
          printEgoSearchResult(rep.name, rep.company, rep.egoSearchResult);
        }
      }

      console.log(`\n【代表者リスク判定】`);
      const riskyReps = representativeEgoSearches.filter(r => r.egoSearchResult.summary.hasNegativeInfo);
      if (riskyReps.length > 0) {
        console.log(`  ⚠️ 代表者リスク: あり（要確認）`);
        console.log(`     リスク検出: ${riskyReps.length}名/${representatives.length}名`);
      } else {
        console.log(`  ✓ 代表者リスク: なし`);
      }
    }

    // 企業検証結果を表示
    console.log(`\n【企業検証結果】`);
    if (applicantCompany) {
      console.log(`\n申込企業:`);
      printCompanyVerificationResultSimple(applicantCompany);
    }

    if (purchaseCompanyResults.length > 0) {
      console.log(`\n買取企業:`);
      purchaseCompanyResults.forEach(r => printCompanyVerificationResultSimple(r));
    }

    if (collateralCompanyResults.length > 0) {
      console.log(`\n担保企業:`);
      collateralCompanyResults.forEach(r => printCompanyVerificationResultSimple(r));
    }
    
    // ========================================
    // 結果サマリーの生成
    // ========================================
    const endTime = Date.now();
    const processingTime = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ [Phase 3] 完了 (処理時間: ${processingTime}秒)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // 本人確認のサマリー
    const 本人確認サマリー = identityResult ? {
      書類タイプ: identityResult.documentType,
      照合結果: identityResult.verificationResults?.summary || identityResult.summary,
      検出人数: identityResult.verificationResults?.personCount || 0,
      一致人数: identityResult.verificationResults?.matchedPersonCount || 0,
      一致人物: (identityResult.matchedPerson && identityResult.matchedPerson.name) ? {
        氏名: identityResult.matchedPerson.name,
        生年月日: identityResult.matchedPerson.birthDate || "不明",
        住所: identityResult.matchedPerson.address || "不明",
      } : undefined,
      // OCR抽出値とKintone期待値の詳細比較（Phase 4で表示）
      抽出された人物情報: identityResult.persons ? identityResult.persons.map((person: any) => ({
        氏名: person.name,
        生年月日: person.birthDate || "不明",
        住所: person.address || "不明",
        氏名一致: person.nameMatch || false,
        生年月日一致: person.birthDateMatch || false,
      })) : [],
      Kintone期待値: identityResult.processingDetails ? {
        代表者名: identityResult.processingDetails.expectedName || "不明",
        生年月日: identityResult.processingDetails.expectedBirthDate || "不明",
      } : undefined,
      会社情報: (identityResult.companyInfo && identityResult.companyInfo.companyName) ? {
        会社名: identityResult.companyInfo.companyName || "不明",
        会社名照合: identityResult.companyInfo.companyNameMatch ? "✓ 一致" : "✗ 不一致",
        資本金: identityResult.companyInfo.capital || "不明",
        設立年月日: identityResult.companyInfo.established || "不明",
        代表者名: identityResult.companyInfo.representative || "不明",
        本店所在地: identityResult.companyInfo.location || "不明",
      } : undefined,
    } : {
      書類タイプ: "なし",
      照合結果: "本人確認書類が添付されていません",
      検出人数: 0,
      一致人数: 0,
    };

    // 申込者エゴサーチのサマリー
    // ネガティブ情報が見つかった場合、全てのURLを収集
    const negativeURLs: Array<{ タイトル: string; URL: string; ソース: string }> = [];

    if (applicantEgoSearch.summary.hasNegativeInfo) {
      // 詐欺情報サイトのURL
      applicantEgoSearch.fraudSiteResults.forEach((fraudSite: any) => {
        if (fraudSite.found && fraudSite.url) {
          negativeURLs.push({
            タイトル: fraudSite.siteName,
            URL: fraudSite.url,
            ソース: "詐欺情報サイト",
          });
        }
      });

      // Web検索結果のURL（AI判定でrelevant=trueのもののみ）
      applicantEgoSearch.negativeSearchResults.forEach((searchResult: any) => {
        if (searchResult.found && searchResult.results && searchResult.results.length > 0) {
          searchResult.results.forEach((result: any) => {
            negativeURLs.push({
              タイトル: result.title,
              URL: result.url,
              ソース: `Web検索: ${searchResult.query}`,
            });
          });
        }
      });
    }

    const 申込者エゴサーチサマリー = {
      ネガティブ情報: applicantEgoSearch.summary.hasNegativeInfo,
      詐欺情報サイト: applicantEgoSearch.summary.fraudHits,
      Web検索: applicantEgoSearch.negativeSearchResults.filter((r: any) => r.found).length,
      詳細: applicantEgoSearch.summary.details,
      ネガティブURL一覧: negativeURLs.length > 0 ? negativeURLs : undefined,
    };

    // 企業実在性のサマリー
    const 企業実在性サマリー = {
      申込企業: applicantCompany ? {
        企業名: applicantCompany.companyName,
        公式サイト: applicantCompany.websiteUrl || "なし",
        確認方法: applicantCompany.verificationSource,
        確認元URL: applicantCompany.verificationUrl || undefined,
        信頼度: applicantCompany.confidence,
      } : applicantInfo.companyName ? {
        企業名: applicantInfo.companyName,
        公式サイト: "なし",
        確認方法: "未確認",
        信頼度: 0,
      } : {
        企業名: "取得失敗",
        公式サイト: "なし",
        確認方法: "未確認",
        信頼度: 0,
      },
      買取企業: {
        総数: purchaseCompanyResults.length,
        確認済み: purchaseCompanyResults.filter((c: any) => c.verified).length,
        未確認: purchaseCompanyResults.filter((c: any) => !c.verified).length,
        企業リスト: purchaseCompanyResults.map((c: any) => ({
          企業名: c.companyName,
          公式サイト: c.websiteUrl || "なし",
          確認方法: c.verificationSource,
          確認元URL: c.verificationUrl || undefined,
          信頼度: c.confidence,
        })),
      },
      担保企業: {
        総数: collateralCompanyResults.length,
        確認済み: collateralCompanyResults.filter((c: any) => c.verified).length,
        未確認: collateralCompanyResults.filter((c: any) => !c.verified).length,
        備考: collateralCompanyResults.length === 0 ? "担保テーブルが空" : undefined,
        企業リスト: collateralCompanyResults.map((c: any) => ({
          企業名: c.companyName,
          公式サイト: c.websiteUrl || "なし",
          確認方法: c.verificationSource,
          確認元URL: c.verificationUrl || undefined,
          信頼度: c.confidence,
        })),
      },
    };
    
    // 代表者リスクのサマリー
    const riskyReps = representativeEgoSearches.filter((r: any) => r.egoSearchResult?.summary?.hasNegativeInfo);
    const 代表者リスクサマリー = {
      検索対象: representativeEgoSearches.length,
      リスク検出: riskyReps.length,
      リスク詳細: riskyReps.length > 0 ? riskyReps.map((r: any) => ({
        氏名: r.name,
        会社: r.company,
        企業種別: r.type,
        ネガティブ情報: r.egoSearchResult.summary.hasNegativeInfo,
        詐欺情報サイト: r.egoSearchResult.fraudSiteResults.filter((f: any) => f.found).length,
        Web検索: r.egoSearchResult.negativeSearchResults.filter((n: any) => n.found).length,
      })) : undefined,
    };

    return {
      recordId,
      phase1Results, // Phase 1の結果を引き継ぎ
      phase2Results, // Phase 2の結果を引き継ぎ
      phase3Results: {
        本人確認: 本人確認サマリー,
        申込者エゴサーチ: 申込者エゴサーチサマリー,
        企業実在性: 企業実在性サマリー,
        代表者リスク: 代表者リスクサマリー,
        処理時間: `${processingTime}秒`,
      },
    };
  },
});


// ========================================
// ヘルパー関数
// ========================================

/**
 * エゴサーチと企業検証を1回のAI呼び出しで一括分析
 */
async function analyzeAllData(
  allEgoSearchData: Array<{
    personType: string;
    name: string;
    company?: string;
    companyType?: string;
    egoSearchResult: any;
  }>,
  companySearchData: Array<{
    companyIndex: number;
    companyName: string;
    companyType: string;
    location?: string;
    searchResults: Array<{
      query: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    }>;
  }>
): Promise<{
  egoSearchAnalysis: {
    persons: Array<{
      personIndex: number;
      queries: Array<{
        queryIndex: number;
        query: string;
        results: Array<{
          resultIndex: number;
          isRelevant: boolean;
          reason: string;
        }>;
      }>;
    }>;
  };
  companyAnalysis: {
    companies: Array<{
      companyIndex: number;
      verified: boolean;
      confidence: number;
      websiteUrl?: string | null;
      verificationUrl?: string | null;
      verificationSource: "公式サイト" | "第三者サイト" | "未確認";
      businessDescription?: string | null;
      capital?: string | null;
      established?: string | null;
      reason?: string;
    }>;
  };
}> {
  try {
    // エゴサーチデータの整形
    const personsInfo = allEgoSearchData.map((person, personIdx) => {
      const queriesInfo = person.egoSearchResult.negativeSearchResults
        .map((queryResult: any, queryIdx: number) => {
          if (!queryResult.found || !queryResult.results || queryResult.results.length === 0) {
            return null;
          }

          const resultsInfo = queryResult.results
            .map((result: any, resultIdx: number) => {
              return `    結果${resultIdx}: ${result.title}\n       ${result.snippet}`;
            })
            .join('\n');

          return `  クエリ${queryIdx}: "${queryResult.query}"\n${resultsInfo}`;
        })
        .filter((q: any) => q !== null)
        .join('\n');

      if (!queriesInfo) {
        return null;
      }

      const personInfo = person.company
        ? `対象者${personIdx}: ${person.name}（${person.personType} - ${person.company}）`
        : `対象者${personIdx}: ${person.name}（${person.personType}）`;

      return `${personInfo}\n${queriesInfo}`;
    }).filter((p: any) => p !== null).join('\n\n');

    // 企業検索データの整形
    const companiesInfo = companySearchData.map((company, companyIdx) => {
      const allResults = company.searchResults.flatMap(s => s.results);

      const resultsInfo = allResults
        .map((r, i) => `  ${i + 1}. ${r.title}\n     URL: ${r.url}\n     ${r.snippet}`)
        .join('\n');

      return `企業${companyIdx}: ${company.companyName}（${company.companyType}）
${company.location ? `所在地: ${company.location}` : ''}
検索結果 (${allResults.length}件):
${resultsInfo}`;
    }).join('\n\n---\n\n');

    const result = await generateObject({
      model: google("gemini-2.5-flash"),
      prompt: `これはファクタリングのためのweb検索結果です。建設業関連の債権回収案件を前提に企業実在性を確認してください。

以下のエゴサーチと企業検証のデータを分析してください。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【パート1: エゴサーチ分析】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${personsInfo || '(エゴサーチ結果なし)'}

【エゴサーチ判定基準】
- 同姓同名の別人（地域・職業が異なる）→ false
- 専門家・警察官として言及 → false
- 容疑者・被告として扱われている → true

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【パート2: 企業検証分析】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${companiesInfo}

【企業検証判定基準】
1. 法人格の照合（株式会社、有限会社など）
2. 企業名の照合
3. 所在地の照合（指定がある場合）
4. サイトの種類判定：
   - 公式サイトが見つかった場合 → verified=true, verificationSource="公式サイト", websiteUrlに公式URL, verificationUrlに公式URL
   - 第三者サイト（建設業許可サイト、助太刀、ツクリンク、社員口コミサイトなど）で確認できた場合 → verified=true, verificationSource="第三者サイト", websiteUrl=null, verificationUrlに第三者サイトのURL
   - 確認不十分 → verified=false, verificationSource="未確認", websiteUrl=null, verificationUrl=null

各データについて判定結果を返してください。`,
      schema: z.object({
        egoSearchAnalysis: z.object({
          persons: z.array(z.object({
            personIndex: z.number(),
            queries: z.array(z.object({
              queryIndex: z.number(),
              query: z.string(),
              results: z.array(z.object({
                resultIndex: z.number(),
                isRelevant: z.boolean(),
                reason: z.string(),
              })),
            })),
          })),
        }),
        companyAnalysis: z.object({
          companies: z.array(z.object({
            companyIndex: z.number(),
            verified: z.boolean(),
            confidence: z.number().min(0).max(100),
            websiteUrl: z.string().nullable().optional(),
            verificationUrl: z.string().nullable().optional(),
            verificationSource: z.enum(["公式サイト", "第三者サイト", "未確認"]),
            businessDescription: z.string().nullable().optional(),
            capital: z.string().nullable().optional(),
            established: z.string().nullable().optional(),
            reason: z.string().optional(),
          })),
        }),
      }),
    });

    return result.object;
  } catch (error) {
    console.error(`AI一括判定エラー:`, error);
    return {
      egoSearchAnalysis: {
        persons: allEgoSearchData.map((person, personIdx) => ({
          personIndex: personIdx,
          queries: person.egoSearchResult.negativeSearchResults
            .map((queryResult: any, queryIdx: number) => {
              if (!queryResult.found || !queryResult.results || queryResult.results.length === 0) {
                return null;
              }
              return {
                queryIndex: queryIdx,
                query: queryResult.query,
                results: queryResult.results.map((_: any, resultIdx: number) => ({
                  resultIndex: resultIdx,
                  isRelevant: true,
                  reason: "AI判定エラー（要手動確認）",
                })),
              };
            })
            .filter((q: any) => q !== null),
        })),
      },
      companyAnalysis: {
        companies: companySearchData.map((company, idx) => ({
          companyIndex: idx,
          verified: false,
          confidence: 0,
          websiteUrl: null,
          verificationUrl: null,
          verificationSource: "未確認" as const,
          businessDescription: null,
          capital: null,
          established: null,
        })),
      },
    };
  }
}

/**
 * AI分析結果でエゴサーチ結果を更新
 */
function updateEgoSearchWithAnalysis(egoSearchResult: any, analysis: any, name: string): void {
  const filteredNegativeResults = [];

  for (let queryIdx = 0; queryIdx < egoSearchResult.negativeSearchResults.length; queryIdx++) {
    const queryResult = egoSearchResult.negativeSearchResults[queryIdx];

    if (!queryResult.found || !queryResult.results || queryResult.results.length === 0) {
      filteredNegativeResults.push(queryResult);
      continue;
    }

    const queryAnalysis = analysis.queries.find((q: any) => q.queryIndex === queryIdx);
    if (!queryAnalysis) {
      filteredNegativeResults.push(queryResult);
      continue;
    }

    const relevantResults = queryResult.results
      .map((searchResult: any, idx: number) => {
        const resultAnalysis = queryAnalysis.results.find((r: any) => r.resultIndex === idx);
        if (resultAnalysis && resultAnalysis.isRelevant) {
          return {
            ...searchResult,
            aiReason: resultAnalysis.reason,
          };
        }
        return null;
      })
      .filter((r: any) => r !== null);

    if (relevantResults.length > 0) {
      filteredNegativeResults.push({
        query: queryResult.query,
        found: true,
        results: relevantResults,
      });
    } else {
      filteredNegativeResults.push({
        query: queryResult.query,
        found: false,
        results: undefined,
      });
    }
  }

  egoSearchResult.negativeSearchResults = filteredNegativeResults;

  // サマリーを再計算
  const fraudHits = egoSearchResult.fraudSiteResults.filter((r: any) => r.found).length;
  const negativeHits = filteredNegativeResults.filter((r: any) => r.found);
  const hasNegativeInfo = negativeHits.length > 0 || fraudHits > 0;

  let details = "";
  if (!hasNegativeInfo) {
    details = "ネガティブ情報は見つかりませんでした。";
  } else {
    if (fraudHits > 0) {
      details = `詐欺情報サイトに${fraudHits}件の情報が見つかりました。`;
    }
    if (negativeHits.length > 0) {
      details += ` Web検索で${negativeHits.map((r: any) => r.query).join('、')}に関する情報が見つかりました（AI判定済み）。`;
    }
  }

  egoSearchResult.summary = {
    hasNegativeInfo,
    fraudHits,
    details,
  };
}

/**
 * エゴサーチ結果の表示
 */
function printEgoSearchResult(name: string, company: string | undefined, result: any): void {
  const header = company ? `  ${name}（${company}）` : `  ${name}`;

  if (result.summary.hasNegativeInfo) {
    console.log(`  ⚠️ ${header}`);

    const fraudHits = result.fraudSiteResults.filter((r: any) => r.found);
    if (fraudHits.length > 0) {
      console.log(`     詐欺情報サイト: ${fraudHits.length}件検出`);
    }

    const negativeHits = result.negativeSearchResults.filter((r: any) => r.found);
    if (negativeHits.length > 0) {
      console.log(`     Web検索: ${negativeHits.map((r: any) => `"${r.query}"`).join('、')} - ${negativeHits.length}件検出`);
      negativeHits.forEach((hit: any) => {
        if (hit.results && hit.results.length > 0) {
          hit.results.slice(0, 2).forEach((r: any, idx: number) => {
            console.log(`       ${idx + 1}. ${r.title}`);
            console.log(`          ${r.url}`);
            if (r.aiReason) {
              console.log(`          AI判定: ${r.aiReason}`);
            }
          });
        }
      });
    }

    console.log(`     詳細: ${result.summary.details}`);
  } else {
    console.log(`  ✓ ${header}`);
    console.log(`     詐欺情報サイト: 該当なし`);
    console.log(`     Web検索: ネガティブ情報なし`);
  }
}

/**
 * Kintoneから申込者名を取得
 */
async function fetchApplicantNameFromKintone(recordId: string): Promise<string> {
  const domain = process.env.KINTONE_DOMAIN;
  const apiToken = process.env.KINTONE_API_TOKEN;
  const appId = process.env.KINTONE_APP_ID || "37";

  if (!domain || !apiToken) {
    console.error("Kintone環境変数が設定されていません");
    return "";
  }

  try {
    const url = `https://${domain}/k/v1/records.json?app=${appId}&query=$id="${recordId}"`;
    const response = await axios.get(url, {
      headers: { 'X-Cybozu-API-Token': apiToken },
    });

    if (response.data.records.length === 0) {
      console.error(`レコードID: ${recordId} が見つかりません`);
      return "";
    }

    const record = response.data.records[0];
    // 申込者氏名を取得
    const applicantName = record.顧客情報＿氏名?.value || "";

    return applicantName;
  } catch (error) {
    console.error("Kintone申込者情報取得エラー:", error);
    return "";
  }
}

/**
 * Kintoneから申込企業名と所在地を取得
 */
async function fetchApplicantCompanyFromKintone(recordId: string): Promise<{ companyName: string; location: string | undefined }> {
  const domain = process.env.KINTONE_DOMAIN;
  const apiToken = process.env.KINTONE_API_TOKEN;
  const appId = process.env.KINTONE_APP_ID || "37";

  if (!domain || !apiToken) {
    console.error("Kintone環境変数が設定されていません");
    return { companyName: "", location: undefined };
  }

  try {
    const url = `https://${domain}/k/v1/records.json?app=${appId}&query=$id="${recordId}"`;
    const response = await axios.get(url, {
      headers: { 'X-Cybozu-API-Token': apiToken },
    });

    if (response.data.records.length === 0) {
      console.error(`レコードID: ${recordId} が見つかりません`);
      return { companyName: "", location: undefined };
    }

    const record = response.data.records[0];
    // 屋号（個人事業主）または会社名（法人）を取得
    const companyName = record.屋号?.value || record.会社名?.value || "";

    // 所在地を取得（企業所在地 → 自宅所在地の優先順位）
    const location = record.本社所在地?.value || record.自宅所在地?.value || undefined;

    return { companyName, location };
  } catch (error) {
    console.error("Kintone申込企業情報取得エラー:", error);
    return { companyName: "", location: undefined };
  }
}

/**
 * Kintoneから担保企業を取得
 */
async function fetchCollateralCompaniesFromKintone(recordId: string): Promise<Array<{ name: string }>> {
  const domain = process.env.KINTONE_DOMAIN;
  const apiToken = process.env.KINTONE_API_TOKEN;
  const appId = process.env.KINTONE_APP_ID || "37";

  if (!domain || !apiToken) {
    console.error("Kintone環境変数が設定されていません");
    return [];
  }

  try {
    const url = `https://${domain}/k/v1/records.json?app=${appId}&query=$id="${recordId}"`;
    const response = await axios.get(url, {
      headers: { 'X-Cybozu-API-Token': apiToken },
    });

    if (response.data.records.length === 0) {
      console.error(`レコードID: ${recordId} が見つかりません`);
      return [];
    }

    const record = response.data.records[0];
    const collateralTable = record.担保情報?.value || [];

    const companies = collateralTable
      .map((row: any) => {
        const companyName = row.value.会社名_第三債務者_担保?.value || "";
        return { name: companyName };
      })
      .filter((c: any) => c.name); // 空の会社名は除外

    return companies;
  } catch (error) {
    console.error("Kintone担保情報取得エラー:", error);
    return [];
  }
}

/**
 * テキストの正規化（照合用）
 */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')          // スペース削除
    .replace(/[　]/g, '')         // 全角スペース削除
    .toLowerCase();
}


/**
 * 企業検証結果の表示（一括検証用）
 */
function printCompanyVerificationResultSimple(result: any): void {
  if (result.verified) {
    console.log(`  ✓ ${result.companyName}: 実在確認`);
    console.log(`     検証方法: ${result.verificationSource}`);

    if (result.verificationSource === "公式サイト" && result.websiteUrl) {
      console.log(`     公式サイト: ${result.websiteUrl}`);
    } else if (result.verificationSource === "第三者サイト" && result.verificationUrl) {
      console.log(`     確認元URL: ${result.verificationUrl}`);
      if (result.websiteUrl) {
        console.log(`     公式サイト: ${result.websiteUrl}`);
      }
    }

    console.log(`     信頼度: ${result.confidence}%`);

    if (result.businessDescription) {
      console.log(`     事業内容: ${result.businessDescription}`);
    }
    if (result.capital) {
      console.log(`     資本金: ${result.capital}`);
    }
    if (result.established) {
      console.log(`     設立: ${result.established}`);
    }
  } else {
    console.log(`  ⚠️ ${result.companyName}: 確認不十分`);
    console.log(`     信頼度: ${result.confidence}%`);
    if (result.websiteUrl) {
      console.log(`     公式サイト: ${result.websiteUrl}`);
    } else {
      console.log(`     公式サイト: なし`);
    }
  }
}


