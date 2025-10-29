const axios = require('axios');

const domain = 'witservice.cybozu.com';
const apiToken = 'Na12yYPO7tmEmB4WD68dS9L9ms2r5f0GoddklNK2';
const appId = '37';

async function getFields() {
  try {
    const url = `https://${domain}/k/v1/app/form/fields.json?app=${appId}`;
    const response = await axios.get(url, {
      headers: {
        'X-Cybozu-API-Token': apiToken,
      },
    });
    
    const fields = response.data.properties;
    
    // 所感、条件、備考に関連するフィールドを抽出
    const targetFields = Object.entries(fields).filter(([key, value]) => {
      const keyLower = key.toLowerCase();
      return keyLower.includes('所感') || 
             keyLower.includes('条件') || 
             keyLower.includes('備考') ||
             keyLower.includes('留意');
    });
    
    console.log('\n=== 所感・条件・備考・留意関連フィールド ===\n');
    targetFields.forEach(([key, value]) => {
      console.log(`フィールドコード: ${key}`);
      console.log(`  ラベル: ${value.label}`);
      console.log(`  タイプ: ${value.type}`);
      console.log('');
    });
    
    console.log('\n=== すべてのフィールドコード一覧 ===\n');
    Object.keys(fields).sort().forEach(key => {
      console.log(`${key}: ${fields[key].label} (${fields[key].type})`);
    });
    
  } catch (error) {
    console.error('エラー:', error.message);
    if (error.response) {
      console.error('レスポンス:', error.response.data);
    }
  }
}

getFields();
