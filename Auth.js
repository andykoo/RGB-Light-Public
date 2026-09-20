/** Auth.gs - Password based authentication */

/**
 * Initialize default admin if none exists
 * Should be called by critical admin functions or doGet
 */
function auth_init_() {
  const count = db_countAdmins_();
  if (count === 0) throw new Error('尚未初始化系統。請由部署者在 Apps Script 編輯器執行 initializeRgbPublic。');
}

/** Initialize a copied database and create the first admin using an owner-provided password. */
function initializeRgbPublic() {
  const activeEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const effectiveEmail = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!activeEmail || !effectiveEmail || activeEmail !== effectiveEmail) {
    throw new Error('為保護資料庫，只能由 Apps Script 專案擁有者在編輯器中執行初始化。');
  }

  const props = PropertiesService.getScriptProperties();
  const spreadsheet = db_getSpreadsheet_();
  db_ensureSheetsAndHeaders_(SHEET_NAMES, HEADERS);
  db_initSystemConfig_();

  let adminCreated = false;
  if (db_countAdmins_() === 0) {
    const initialPassword = props.getProperty('RGB_INITIAL_ADMIN_PASSWORD');
    if (!initialPassword) {
      throw new Error('請先在「專案設定 > 指令碼屬性」設定 RGB_INITIAL_ADMIN_PASSWORD，再重新執行初始化。');
    }
    auth_validatePasswordComplexity_(initialPassword);
    const salt = auth_generateSalt_();
    db_createAdmin_({
      username: 'admin',
      passwordHash: auth_hash_(initialPassword, salt),
      salt: salt,
      isDefaultPassword: true,
      role: 'SUPER_ADMIN'
    });
    adminCreated = true;
  }

  // Do not leave the initial plaintext password in Script Properties after setup.
  props.deleteProperty('RGB_INITIAL_ADMIN_PASSWORD');
  return {
    success: true,
    databaseName: spreadsheet.getName(),
    databaseUrl: spreadsheet.getUrl(),
    adminCreated: adminCreated,
    adminUsername: 'admin'
  };
}

/**
 * Login function
 * @param {string} username
 * @param {string} password
 * @return {Object} { success, token, forceChange, message }
 */
function auth_login(username, password) {
  auth_init_(); // Ensure admins exist
  
  const admin = db_getAdmin_(username);
  if (!admin) {
    // Fake hash to prevent timing attacks? In GAS timing attacks are hard anyway due to latency.
    return { success: false, message: '使用者名稱或密碼錯誤' };
  }
  
  const hash = auth_hash_(password, admin.salt);
  if (hash !== admin.passwordHash) {
    return { success: false, message: '使用者名稱或密碼錯誤' };
  }
  
  // Success
  const token = Utilities.getUuid();
  db_createSession_(token, admin.username);
  
  // Update last login
  db_updateAdmin_(admin.username, { lastLoginAt: Date.now() });
  
  return {
    success: true,
    token: token,
    forceChange: !!admin.isDefaultPassword,
    username: admin.username,
    role: admin.role || 'ADMIN'
  };
}

/**
 * Change Password
 * @param {string} token
 * @param {string} oldPass
 * @param {string} newPass
 */
function auth_changePassword(token, oldPass, newPass) {
  const session = auth_validateToken(token);
  if (!session) throw new Error('未授權或連線已逾時');
  
  const admin = db_getAdmin_(session.username);
  if (!admin) throw new Error('找不到使用者'); // Should not happen
  
  // Verify old pass
  const oldHash = auth_hash_(oldPass, admin.salt);
  if (oldHash !== admin.passwordHash) {
    throw new Error('舊密碼錯誤');
  }
  
  // Validate complexity
  auth_validatePasswordComplexity_(newPass);

  // Set new pass
  const newSalt = auth_generateSalt_();
  const newHash = auth_hash_(newPass, newSalt);
  
  db_updateAdmin_(session.username, {
    passwordHash: newHash,
    salt: newSalt,
    isDefaultPassword: false
  });
  
  return { success: true };
}

/**
 * Validate Token
 */
function auth_validateToken(token) {
  if (!token) return null;
  return db_getSession_(token);
}

/**
 * Assert Admin by Token
 * used by API functions
 */
function assertAdminByToken_(token) {
  const session = auth_validateToken(token);
  if (!session) {
    throw new Error('無管理者權限 (Invalid Token)');
  }
  return session;
}


/**
 * Helpers
 */
function auth_generateSalt_() {
  return Utilities.getUuid();
}

function auth_hash_(password, salt) {
  const input = salt + password;
  const rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  
  // Convert byte array to hex string
  let txtHash = '';
  for (let i = 0; i < rawHash.length; i++) {
    let hashVal = rawHash[i];
    if (hashVal < 0) {
      hashVal += 256;
    }
    if (hashVal.toString(16).length == 1) {
      txtHash += '0';
    }
    txtHash += hashVal.toString(16);
  }
  return txtHash;
}

/* API Wrappers (Exposed to global because they might be called from Code.gs) */
// Actually Code.gs will wrap these.

function auth_validatePasswordComplexity_(password) {
  if (!password || password.length < 8) {
    throw new Error('密碼長度需至少 8 碼');
  }
  
  // Rules: Uppercase, Lowercase, Number, Special
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  // Special chars: anything not A-Z, a-z, 0-9
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  
  if (!hasUpper) throw new Error('密碼需包含至少一個大寫字母');
  if (!hasLower) throw new Error('密碼需包含至少一個小寫字母');
  if (!hasNumber) throw new Error('密碼需包含至少一個數字');
  if (!hasSpecial) throw new Error('密碼需包含至少一個特殊符號');
}
