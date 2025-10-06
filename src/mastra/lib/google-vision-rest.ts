import axios from 'axios';
import jwt from 'jsonwebtoken';

// Google Vision REST APIのヘルパー

/**
 * サービスアカウントJSONからアクセストークンを取得
 */
async function getAccessToken(): Promise<string> {
  // 環境変数から認証情報を取得
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (!credentialsJson) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON環境変数が設定されていません');
  }

  const credentials = JSON.parse(credentialsJson);
  const { client_email, private_key } = credentials;

  // JWTを生成
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const token = jwt.sign(payload, private_key, { algorithm: 'RS256' });

  // アクセストークンを取得
  const response = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: token,
  });

  return response.data.access_token;
}

/**
 * Google Vision APIでOCR実行（画像）
 */
export async function annotateImage(base64Content: string): Promise<any> {
  const accessToken = await getAccessToken();

  const response = await axios.post(
    'https://vision.googleapis.com/v1/images:annotate',
    {
      requests: [{
        image: { content: base64Content },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'TEXT_DETECTION' },
        ],
        imageContext: { languageHints: ['ja'] },
      }],
    },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.responses[0];
}

/**
 * Google Vision APIでOCR実行（PDFバッチ）
 */
export async function batchAnnotateFiles(
  base64Content: string,
  mimeType: string,
  pages: number[]
): Promise<any> {
  const accessToken = await getAccessToken();

  const response = await axios.post(
    'https://vision.googleapis.com/v1/files:annotate',
    {
      requests: [{
        inputConfig: {
          content: base64Content,
          mimeType,
        },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'TEXT_DETECTION' },
        ],
        pages,
        imageContext: { languageHints: ['ja'] },
      }],
    },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.responses[0];
}
