/** Auth.gs - Password based authentication */

/**
 * Initialize default admin if none exists
 * Should be called by critical admin functions or doGet
 */
function auth_init_() {
  const count = db_countAdmins_();
  if (count === 0) {
    // defaults
    const salt = auth_generateSalt_();
    const pass = 'admin1234';
    const hash = auth_hash_(pass, salt);
    
    db_createAdmin_({
      username: 'admin',
      passwordHash: hash,
      salt: salt,
      passwordHash: hash,
      salt: salt,
      isDefaultPassword: true,
      role: 'SUPER_ADMIN'
    });
    console.log('Default admin created: admin / admin1234');
  }
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
