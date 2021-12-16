const crypto = require('crypto'),
    https = require('https'),
    zlib = require('zlib');

function awsApiRequest(options, retryAttempt = 0) {
    return new Promise((resolve, reject) => {
        let region = options.region || awsApiRequest.region || process.env.AWS_DEFAULT_REGION,
            service = options.service,
            accessKey = options.accessKey || awsApiRequest.accessKey || process.env.AWS_ACCESS_KEY_ID,
            secretKey = options.secretKey || awsApiRequest.secretKey || process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken = options.sessionToken || awsApiRequest.sessionToken || process.env.AWS_SESSION_TOKEN,
            method = options.method || 'GET',
            path = options.path || '/',
            querystring = options.querystring || {},
            payload = options.payload || '',
            host = options.host || `${service}.${region}.amazonaws.com`,
            headers = options.headers || {};

        if (region.match(/^cn-/)) {
            host += '.cn'; //Special case for AWS China...
        }

        function hmacSha256(data, key, hex = false) {
            return crypto.createHmac('sha256', key).update(data).digest(hex ? 'hex' : undefined);
        }

        function sha256(data) {
            return crypto.createHash('sha256').update(data).digest('hex');
        }

        //Thanks to https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html#signature-v4-examples-javascript
        function createSigningKey(secretKey, dateStamp, region, serviceName) {
            let kDate = hmacSha256(dateStamp, 'AWS4' + secretKey);
            let kRegion = hmacSha256(region, kDate);
            let kService = hmacSha256(serviceName, kRegion);
            let kSigning = hmacSha256('aws4_request', kService);
            return kSigning;
        }

        function createSignedHeaders(headers) {
            return Object.keys(headers).sort().map(h => h.toLowerCase()).join(';');
        }

        function createStringToSign(timestamp, region, service, canonicalRequest) {
            let stringToSign = 'AWS4-HMAC-SHA256\n';
            stringToSign += timestamp + '\n';
            stringToSign += timestamp.substr(0, 8) + '/' + region + '/' + service + '/aws4_request\n';
            stringToSign += sha256(canonicalRequest);
            return stringToSign;
        }

        function createCanonicalRequest(method, path, querystring, headers, payload) {
            let canonical = method + '\n';

            //Changed this from double encoding the path to single encoding it, to make S3 paths with spaces work. However, the documentation said to
            //double encode it...? The only time we actually encode a path other than / is when uploading to S3 so just change this to single encoding here
            //but it's possible it will mess up if the path has some weird characters that should be double encoded maybe??? If you had weird symbols in your version number?
            //
            //Unencoded parentheses in the path is valid. However, they must be encoded in the canonical path to pass signature verification even if
            //the actual path has them unencoded.
            canonical += encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29') + '\n';

            let qsKeys = Object.keys(querystring);
            qsKeys.sort();

            //encodeURIComponent does NOT encode ', but we need it to be encoded. escape() is considered deprecated, so encode '
            //manually. Also, using escape fails for some reason.
            function encodeValue(v) {
                return encodeURIComponent(v).replace(/'/g, '%27').replace(/:/g, '%3A').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/!/g, '%21').replace(/\*/g, '%2A');
            }

            let qsEntries = qsKeys.map(k => `${k}=${encodeValue(querystring[k])}`);
            canonical += qsEntries.join('&') + '\n';

            let headerKeys = Object.keys(headers).sort();
            let headerEntries = headerKeys.map(h => h.toLowerCase() + ':' + headers[h].replace(/^\s*|\s*$/g, '').replace(' +', ' '));
            canonical += headerEntries.join('\n') + '\n\n';

            canonical += createSignedHeaders(headers) + '\n';
            canonical += sha256(payload);

            return canonical;
        }

        function createAuthHeader(accessKey, timestamp, region, service, headers, signature) {
            let date = timestamp.substr(0, 8);
            let signedHeaders = createSignedHeaders(headers);
            return `AWS4-HMAC-SHA256 Credential=${accessKey}/${date}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        }

        let timestamp = new Date().toISOString().replace(/(-|:|\.\d\d\d)/g, ''); // YYYYMMDD'T'HHmmSS'Z'
        let datestamp = timestamp.substr(0, 8);

        let sessionTokenHeader = sessionToken ? { 'x-amz-security-token': sessionToken } : {};

        let reqHeaders = Object.assign({
            Accept: 'application/json',
            Host: host,
            'Content-Type': 'application/json',
            'x-amz-date': timestamp,
            'x-amz-content-sha256': sha256(payload)
        }, sessionTokenHeader, headers); // Passed in headers override these...

        let canonicalRequest = createCanonicalRequest(method, path, querystring, reqHeaders, payload);
        let stringToSign = createStringToSign(timestamp, region, service, canonicalRequest);
        let signingKey = createSigningKey(secretKey, datestamp, region, service);
        let signature = hmacSha256(stringToSign, signingKey, true);
        let authHeader = createAuthHeader(accessKey, timestamp, region, service, reqHeaders, signature);

        reqHeaders.Authorization = authHeader;

        const MAX_RETRY_COUNT = 10;

        //Now, lets finally do a HTTP REQUEST!!!
        request(method, encodeURI(path), reqHeaders, querystring, payload, retryAttempt, (err, result) => {
            if (err) {
                reject(err);
            } else {
                if (result.statusCode >= 300 && result.statusCode < 400 && result.headers.location) {
                    const url = new URL(result.headers.location);
                    headers.Host = url.hostname;
                    resolve(awsApiRequest({
                        ...options,
                        host: url.hostname
                    }));
                } else if (wasThrottled(result)) {
                    //Exponential backoff with a 500ms jitter
                    let timeout = Math.pow(2, retryAttempt) * 100 + Math.floor(Math.random() * 500);
                    //Exponential backoff...
                    //2~0 * 100 = 100
                    //2~1 * 100 = 200
                    //2~2 * 100 = 400
                    //2~3 * 100 = 800
                    //2~4 * 100 = 1600
                    //2~5 * 100 = 3200
                    //2~6 * 100 = 6400
                    //2~7 * 100 = 12800
                    //2~8 * 100 = 25600
                    //2~9 * 100 = 51200

                    if (retryAttempt > MAX_RETRY_COUNT) {
                        //Give them the error result, the caller can then deal with it...
                        console.warn(`Retry attempt exceeded max retry count (${MAX_RETRY_COUNT})... Giving up...`);
                        resolve(result);
                        return;
                    }
                    if (querystring.Operation) {
                        console.warn(`Request for ${querystring.Operation} in ${options.service} was throttled (retry attempt ${retryAttempt}). Retrying in ${timeout}ms...`);
                    } else {
                        console.warn(`Request for service "${options.service}, path "${options.path}", method "${options.method}" was throttled (retry attempt ${retryAttempt}). Retrying in ${timeout}ms...`);
                    }
                    setTimeout(() => resolve(awsApiRequest(options, retryAttempt + 1)), timeout);
                } else {
                    resolve(result);
                }
            }
        });
    });
}

function wasThrottled(result) {
    return result.statusCode === 400 && result.data && result.data.Error && result.data.Error.Code === 'Throttling';
}

function createResult(data, res) {
    if (!data || data.length === 0) {
        return { statusCode: res.statusCode, headers: res.headers, data: '' };
    }
    if (data && data.length > 0 && res.headers['content-type'] === 'application/json') {
        return { statusCode: res.statusCode, headers: res.headers, data: JSON.parse(data) };
    } else {
        return { statusCode: res.statusCode, headers: res.headers, data };
    }
}

function request(method, path, headers, querystring, data, retryAttempt, callback) {

    let qs = Object.keys(querystring).map(k => `${k}=${encodeURIComponent(querystring[k])}`).join('&');
    path += '?' + qs;
    let hostname = headers.Host;
    delete headers.Host;
    headers['Content-Length'] = data.length;
    const port = 443;

    try {
        const options = { hostname, port, path, method, headers };
        const req = https.request(options, res => {

            let chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                if (res.headers['content-encoding'] === 'gzip') {
                    zlib.gunzip(buffer, (err, decoded) => {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, createResult(decoded, res));
                        }
                    });
                } else {
                    callback(null, createResult(buffer, res));
                }
            });

        });
        req.on('error', err => callback(err));

        if (data) {
            req.write(data);
        }
        req.end();
    } catch (err) {
        callback(err);
    }
}

module.exports = awsApiRequest;
