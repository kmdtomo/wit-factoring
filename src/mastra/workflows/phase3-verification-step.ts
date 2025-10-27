import { createStep } from "@mastra/core/workflows";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import axios from "axios";
import { googleVisionIdentityOcrTool } from "../tools/google-vision-identity-ocr-tool";
import { identityVerificationTool } from "../tools/identity-verification-tool";
import { egoSearchTool, fetchArticleContent } from "../tools/ego-search-tool";
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
    // Step 6: エゴサーチ＋企業検証 AI分析（2段階）
    // ========================================
    console.log(`\n━━━ Step 6: エゴサーチ＋企業検証 AI分析（2段階） ━━━`);

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

    // 【第1段階】スニペットで簡易AI判定
    console.log(`\n【第1段階】Web検索スニペット簡易判定... (gemini-2.5-flash)`);
    const stage1StartTime = Date.now();
    const stage1Results = await analyzeStage1Snippets(allEgoSearchData, companySearchResult.companies);
    const stage1Duration = Date.now() - stage1StartTime;
    console.log(`第1段階完了 - 処理時間: ${stage1Duration}ms`);

    // 【第2段階】関連性ありの記事本文を取得してAI精密判定
    console.log(`\n【第2段階】関連性ありの記事本文を取得中...`);
    const stage2StartTime = Date.now();
    await fetchRelevantArticleContents(allEgoSearchData, stage1Results);
    const fetchDuration = Date.now() - stage2StartTime;
    console.log(`記事本文取得完了 - 処理時間: ${fetchDuration}ms`);

    console.log(`\n【第2段階】記事本文精密判定... (gemini-2.5-flash)`);
    const stage2AIStartTime = Date.now();
    const analysisResults = await analyzeStage2FullContent(allEgoSearchData, companySearchResult.companies);
    const stage2AIDuration = Date.now() - stage2AIStartTime;
    console.log(`第2段階AI判定完了 - 処理時間: ${stage2AIDuration}ms`);

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
 * 【第1段階】Web検索スニペットの簡易AI判定
 * 関連性がありそうな記事を抽出
 */
async function analyzeStage1Snippets(
  allEgoSearchData: Array<{
    personType: string;
    name: string;
    company?: string;
    companyType?: string;
    egoSearchResult: any;
  }>,
  _companySearchData: Array<{
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
          needsFullCheck: boolean;
          reason: string;
        }>;
      }>;
    }>;
  };
}> {
  try {
    // Web検索結果のスニペットのみを整形
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

    if (!personsInfo) {
      // Web検索結果がない場合は空の結果を返す
      return {
        egoSearchAnalysis: {
          persons: allEgoSearchData.map((_person, personIdx) => ({
            personIndex: personIdx,
            queries: [],
          })),
        },
      };
    }

    const result = await generateObject({
      model: google("gemini-2.5-flash"),
      prompt: `これはファクタリングのためのWeb検索結果（スニペットのみ）です。

以下のWeb検索結果のスニペットを見て、記事本文を取得して精密に確認する必要があるかを判定してください。

${personsInfo}

【判定基準】
- 明らかに無関係（同姓同名の別人、地域・職業が異なる）→ needsFullCheck=false
- 専門家・警察官として言及されているだけ → needsFullCheck=false
- 関連性がありそう（容疑者・被告、詐欺被害など）→ needsFullCheck=true（記事本文で精密確認が必要）

スニペットだけでは判断できない場合も needsFullCheck=true としてください。`,
      schema: z.object({
        egoSearchAnalysis: z.object({
          persons: z.array(z.object({
            personIndex: z.number(),
            queries: z.array(z.object({
              queryIndex: z.number(),
              query: z.string(),
              results: z.array(z.object({
                resultIndex: z.number(),
                needsFullCheck: z.boolean().describe("記事本文の精密確認が必要か"),
                reason: z.string().describe("判定理由"),
              })),
            })),
          })),
        }),
      }),
    });

    return result.object;
  } catch (error) {
    console.error(`第1段階AI判定エラー:`, error);
    // エラー時は全て精密確認が必要として扱う
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
                  needsFullCheck: true,
                  reason: "AI判定エラー（要手動確認）",
                })),
              };
            })
            .filter((q: any) => q !== null),
        })),
      },
    };
  }
}

/**
 * 【第1.5段階】関連性ありの記事本文を取得
 */
async function fetchRelevantArticleContents(
  allEgoSearchData: Array<{
    personType: string;
    name: string;
    company?: string;
    companyType?: string;
    egoSearchResult: any;
  }>,
  stage1Results: {
    egoSearchAnalysis: {
      persons: Array<{
        personIndex: number;
        queries: Array<{
          queryIndex: number;
          query: string;
          results: Array<{
            resultIndex: number;
            needsFullCheck: boolean;
            reason: string;
          }>;
        }>;
      }>;
    };
  }
): Promise<void> {
  let totalArticlesToFetch = 0;
  let fetchedArticles = 0;

  // 取得が必要な記事数をカウント
  for (const personAnalysis of stage1Results.egoSearchAnalysis.persons) {
    for (const queryAnalysis of personAnalysis.queries) {
      for (const resultAnalysis of queryAnalysis.results) {
        if (resultAnalysis.needsFullCheck) {
          totalArticlesToFetch++;
        }
      }
    }
  }

  console.log(`  関連性ありと判定された記事: ${totalArticlesToFetch}件`);

  // 各人物のエゴサーチ結果を更新
  for (let personIdx = 0; personIdx < allEgoSearchData.length; personIdx++) {
    const person = allEgoSearchData[personIdx];
    const personAnalysis = stage1Results.egoSearchAnalysis.persons.find(p => p.personIndex === personIdx);

    if (!personAnalysis) continue;

    for (let queryIdx = 0; queryIdx < person.egoSearchResult.negativeSearchResults.length; queryIdx++) {
      const queryResult = person.egoSearchResult.negativeSearchResults[queryIdx];
      const queryAnalysis = personAnalysis.queries.find(q => q.queryIndex === queryIdx);

      if (!queryAnalysis || !queryResult.results) continue;

      // 並列で記事本文を取得
      await Promise.all(
        queryResult.results.map(async (result: any, resultIdx: number) => {
          const resultAnalysis = queryAnalysis.results.find(r => r.resultIndex === resultIdx);

          if (resultAnalysis && resultAnalysis.needsFullCheck) {
            console.log(`  記事取得中 (${++fetchedArticles}/${totalArticlesToFetch}): ${result.title}`);
            const htmlContent = await fetchArticleContent(result.url);
            result.htmlContent = htmlContent;
          }
        })
      );
    }
  }

  console.log(`  記事本文取得完了: ${fetchedArticles}件`);
}

/**
 * 【第2段階】記事本文を含む精密AI判定
 * エゴサーチと企業検証を一括分析
 */
async function analyzeStage2FullContent(
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
      fraudSiteArticles?: Array<{
        articleIndex: number;
        isRelevant: boolean;
        extractedName: string;
        nameMatch: boolean;
        isFraudRelated: boolean;
        reason: string;
      }>;
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
      // 詐欺情報サイトの記事情報
      const fraudSiteInfo = person.egoSearchResult.fraudSiteResults
        .filter((fraudSite: any) => fraudSite.found && fraudSite.articles && fraudSite.articles.length > 0)
        .map((fraudSite: any) => {
          const articlesInfo = fraudSite.articles
            .map((article: any, articleIdx: number) => {
              // HTMLから本文テキストを抽出（タグを除去）
              const textContent = article.htmlContent
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // scriptタグ除去
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // styleタグ除去
                .replace(/<[^>]+>/g, ' ') // HTMLタグ除去
                .replace(/\s+/g, ' ') // 連続する空白を1つに
                .trim()
                .substring(0, 3000); // 最大3000文字

              return `    記事${articleIdx}: ${article.title}\n       URL: ${article.url}\n       本文抜粋: ${textContent.substring(0, 500)}...`;
            })
            .join('\n');

          return `  【${fraudSite.siteName}】\n${articlesInfo}`;
        })
        .join('\n');

      // Web検索結果の情報（記事本文がある場合は含める）
      const queriesInfo = person.egoSearchResult.negativeSearchResults
        .map((queryResult: any, queryIdx: number) => {
          if (!queryResult.found || !queryResult.results || queryResult.results.length === 0) {
            return null;
          }

          const resultsInfo = queryResult.results
            .map((result: any, resultIdx: number) => {
              let info = `    結果${resultIdx}: ${result.title}\n       スニペット: ${result.snippet}`;

              // 記事本文がある場合は含める
              if (result.htmlContent) {
                const textContent = result.htmlContent
                  .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                  .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .substring(0, 3000);

                info += `\n       本文抜粋: ${textContent.substring(0, 500)}...`;
              }

              return info;
            })
            .join('\n');

          return `  クエリ${queryIdx}: "${queryResult.query}"\n${resultsInfo}`;
        })
        .filter((q: any) => q !== null)
        .join('\n');

      if (!fraudSiteInfo && !queriesInfo) {
        return null;
      }

      const personInfo = person.company
        ? `対象者${personIdx}: ${person.name}（${person.personType} - ${person.company}）`
        : `対象者${personIdx}: ${person.name}（${person.personType}）`;

      let info = personInfo;
      if (fraudSiteInfo) {
        info += `\n\n【詐欺情報サイト】\n${fraudSiteInfo}`;
      }
      if (queriesInfo) {
        info += `\n\n【Web検索】\n${queriesInfo}`;
      }

      return info;
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

**【重要】名前の一致判定ルール（完全一致のみ）:**
- **許容される表記ゆれ**:
  - カタカナ ⇔ ひらがな（サトウ ⇔ さとう）
  - 全角 ⇔ 半角
  - スペース有無
- **許容されない**:
  - **漢字の違いは全て別人として扱う**
  - 旧字体・新字体も含め、異なる漢字は全て別人
- **完全一致**とは: 上記の許容される表記ゆれを除き、**全ての文字が一致すること**

例:
- 「佐藤友哉」 と 「佐藤友也」 → **別人（異字）** → nameMatch=false
- 「斎藤太郎」 と 「齋藤太郎」 → **別人（異字）** → nameMatch=false
- 「田中一郎」 と 「田中一朗」 → **別人（異字）** → nameMatch=false
- 「サトウタロウ」 と 「さとうたろう」 → 同一人物（カナ表記ゆれ） → nameMatch=true

＜詐欺情報サイトの記事＞（最重要・厳格判定）
1. 記事本文から人物名を抽出してください
2. 抽出した名前と対象者名を上記ルールで比較
3. **完全一致（許容される表記ゆれのみ）の場合のみ nameMatch=true**
4. 記事内容が詐欺・犯罪に関するものか判定
5. 本人との関連性を総合判定：
   - 名前が完全一致 + 詐欺・犯罪関連の内容 → isRelevant=true（クリティカル）
   - **名前が類似（異字）or 内容が曖昧 → isRelevant=false**
   - 同姓同名の別人（地域・職業が明らかに異なる）→ isRelevant=false

＜Web検索結果＞（記事本文がある場合は精密判定）
- 記事本文がある場合：
  1. 記事本文から人物名を抽出
  2. 対象者名と上記ルールで完全一致するか確認
  3. 詐欺・犯罪関連の内容か判定
  4. **完全一致（許容される表記ゆれのみ）+ 詐欺・犯罪関連 → isRelevant=true**
  5. **異字による類似（哉≠也など）→ isRelevant=false**
- 記事本文がない場合（スニペットのみ）：
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
            fraudSiteArticles: z.array(z.object({
              articleIndex: z.number(),
              isRelevant: z.boolean().describe("本人の詐欺情報として確定的か"),
              extractedName: z.string().describe("記事から抽出した人物名"),
              nameMatch: z.boolean().describe("対象者名と完全一致するか（表記ゆれ考慮）"),
              isFraudRelated: z.boolean().describe("詐欺・犯罪に関する内容か"),
              reason: z.string().describe("判定理由の詳細"),
            })).optional().describe("詐欺情報サイトの記事判定結果"),
            queries: z.array(z.object({
              queryIndex: z.number(),
              query: z.string(),
              results: z.array(z.object({
                resultIndex: z.number(),
                isRelevant: z.boolean(),
                reason: z.string(),
                extractedName: z.string().optional().describe("記事本文から抽出した人物名（本文がある場合）"),
                nameMatch: z.boolean().optional().describe("対象者名と完全一致するか（本文がある場合）"),
                isFraudRelated: z.boolean().optional().describe("詐欺・犯罪に関する内容か（本文がある場合）"),
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
          fraudSiteArticles: person.egoSearchResult.fraudSiteResults
            .filter((fraudSite: any) => fraudSite.found && fraudSite.articles && fraudSite.articles.length > 0)
            .flatMap((fraudSite: any) =>
              fraudSite.articles.map((_: any, articleIdx: number) => ({
                articleIndex: articleIdx,
                isRelevant: true,
                extractedName: "AI判定エラー",
                nameMatch: false,
                isFraudRelated: true,
                reason: "AI判定エラー（要手動確認）",
              }))
            ),
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
        companies: companySearchData.map((_company, idx) => ({
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
  // 詐欺情報サイトの結果を更新
  let totalFraudHits = 0;

  for (const fraudSite of egoSearchResult.fraudSiteResults) {
    if (!fraudSite.found || !fraudSite.articles || fraudSite.articles.length === 0) {
      continue;
    }

    const relevantArticles = fraudSite.articles
      .map((article: any, idx: number) => {
        const articleAnalysis = analysis.fraudSiteArticles?.find((a: any) => a.articleIndex === idx);
        if (articleAnalysis && articleAnalysis.isRelevant) {
          totalFraudHits++;
          return {
            ...article,
            aiAnalysis: {
              extractedName: articleAnalysis.extractedName,
              nameMatch: articleAnalysis.nameMatch,
              isFraudRelated: articleAnalysis.isFraudRelated,
              reason: articleAnalysis.reason,
            },
          };
        }
        return null;
      })
      .filter((a: any) => a !== null);

    if (relevantArticles.length > 0) {
      fraudSite.found = true;
      fraudSite.articles = relevantArticles;
      fraudSite.details = `${name}に関する記事: ${relevantArticles.length}件（AI精密判定済み）`;
    } else {
      fraudSite.found = false;
      fraudSite.articles = undefined;
      fraudSite.details = "AI判定の結果、本人との関連性なし";
    }
  }

  // Web検索結果を更新
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
            aiAnalysis: resultAnalysis.extractedName ? {
              extractedName: resultAnalysis.extractedName,
              nameMatch: resultAnalysis.nameMatch,
              isFraudRelated: resultAnalysis.isFraudRelated,
            } : undefined,
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
  const negativeHits = filteredNegativeResults.filter((r: any) => r.found);
  const hasNegativeInfo = negativeHits.length > 0 || totalFraudHits > 0;

  let details = "";
  if (!hasNegativeInfo) {
    details = "ネガティブ情報は見つかりませんでした（AI精密判定済み）。";
  } else {
    if (totalFraudHits > 0) {
      details = `詐欺情報サイトに${totalFraudHits}件の確定的な情報が見つかりました（AI精密判定済み）。`;
    }
    if (negativeHits.length > 0) {
      details += ` Web検索で${negativeHits.map((r: any) => r.query).join('、')}に関する情報が見つかりました（AI判定済み）。`;
    }
  }

  egoSearchResult.summary = {
    hasNegativeInfo,
    fraudHits: totalFraudHits,
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
      console.log(`     詐欺情報サイト: ${fraudHits.length}件検出（AI精密判定済み）`);
      fraudHits.forEach((fraudSite: any) => {
        console.log(`       【${fraudSite.siteName}】`);
        if (fraudSite.articles && fraudSite.articles.length > 0) {
          fraudSite.articles.forEach((article: any, idx: number) => {
            console.log(`         ${idx + 1}. ${article.title}`);
            console.log(`            URL: ${article.url}`);
            if (article.aiAnalysis) {
              console.log(`            抽出名: ${article.aiAnalysis.extractedName}`);
              console.log(`            名前一致: ${article.aiAnalysis.nameMatch ? "✓ 完全一致" : "✗ 不一致"}`);
              console.log(`            詐欺関連: ${article.aiAnalysis.isFraudRelated ? "✓ あり" : "✗ なし"}`);
              console.log(`            AI判定: ${article.aiAnalysis.reason}`);
            }
          });
        }
      });
    }

    const negativeHits = result.negativeSearchResults.filter((r: any) => r.found);
    if (negativeHits.length > 0) {
      console.log(`     Web検索: ${negativeHits.map((r: any) => `"${r.query}"`).join('、')} - ${negativeHits.length}件検出`);
      negativeHits.forEach((hit: any) => {
        if (hit.results && hit.results.length > 0) {
          hit.results.slice(0, 2).forEach((r: any, idx: number) => {
            console.log(`       ${idx + 1}. ${r.title}`);
            console.log(`          ${r.url}`);
            if (r.aiAnalysis) {
              console.log(`          抽出名: ${r.aiAnalysis.extractedName}`);
              console.log(`          名前一致: ${r.aiAnalysis.nameMatch ? "✓ 完全一致" : "✗ 不一致"}`);
              console.log(`          詐欺関連: ${r.aiAnalysis.isFraudRelated ? "✓ あり" : "✗ なし"}`);
            }
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
    console.log(`     詐欺情報サイト: 該当なし（AI精密判定済み）`);
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


