#!/usr/bin/env node
// Author: Einar Egilsson, https://github.com/einaregilsson/beanstalk-deploy

const awsApiRequest = require('./aws-api-request');
const fs = require('fs');

const IS_GITHUB_ACTION = !!process.env.GITHUB_ACTIONS;

if (IS_GITHUB_ACTION) {
    console.error = msg => console.log(`::error::${msg}`);
    console.warn = msg => console.log(`::warning::${msg}`);
}

function createStorageLocation() {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {Operation: 'CreateStorageLocation', Version: '2010-12-01'}
    });
}

function checkIfFileExistsInS3(bucket, s3Key) {

    return awsApiRequest({
        service : 's3', 
        host: `${bucket}.s3.${awsApiRequest.region}.amazonaws.com`,
        path : s3Key,
        method: 'HEAD'
    });
}

function readFile(path) {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (err, data) => {
            if (err) {
                reject(err);
            }
            resolve(data);
        });
    });
}

function uploadFileToS3(bucket, s3Key, filebuffer) {
    return awsApiRequest({
        service : 's3', 
        host: `${bucket}.s3.${awsApiRequest.region}.amazonaws.com`,
        path : s3Key,
        method: 'PUT',
        headers: { 'Content-Type' : 'application/octet-stream'},
        payload: filebuffer
    });
}

function createBeanstalkVersion(application, bucket, s3Key, versionLabel, versionDescription) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'CreateApplicationVersion', 
            Version: '2010-12-01',
            ApplicationName : application,
            VersionLabel : versionLabel,
            Description : versionDescription,
            'SourceBundle.S3Bucket' : bucket,
            'SourceBundle.S3Key' : s3Key.substr(1) //Don't want leading / here
        }
    });
}

function deployBeanstalkVersion(application, environmentName, versionLabel) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'UpdateEnvironment', 
            Version: '2010-12-01',
            ApplicationName : application,
            EnvironmentName : environmentName,
            VersionLabel : versionLabel
        }
    });
}

function describeEvents(application, environmentName, startTime) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'DescribeEvents', 
            Version: '2010-12-01',
            ApplicationName : application,
            Severity : 'TRACE',
            EnvironmentName : environmentName,
            StartTime : startTime.toISOString().replace(/(-|:|\.\d\d\d)/g, '')
        }
    });
}

function describeEnvironments(application, environmentName) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'DescribeEnvironments', 
            Version: '2010-12-01',
            ApplicationName : application,
            'EnvironmentNames.members.1' : environmentName //Yes, that's the horrible way to pass an array...
        }
    });
}

function getApplicationVersion(application, versionLabel) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'DescribeApplicationVersions', 
            Version: '2010-12-01',
            ApplicationName : application,
            'VersionLabels.members.1' : versionLabel //Yes, that's the horrible way to pass an array...
        }
    });
}

function expect(status, result, extraErrorMessage) {
    if (status !== result.statusCode) { 
        if (extraErrorMessage) {
            console.log(extraErrorMessage);
        }
        if (result.headers['content-type'] !== 'application/json') {
            throw new Error(`Status: ${result.statusCode}. Message: ${result.data}`);
        } else {
            throw new Error(`Status: ${result.statusCode}. Code: ${result.data.Error.Code}, Message: ${result.data.Error.Message}`);
        }
    }
}

//Uploads zip file, creates new version and deploys it
function deployNewVersion(application, environmentName, versionLabel, versionDescription, file, bucket, waitUntilDeploymentIsFinished, waitForRecoverySeconds) {
    //Lots of characters that will mess up an S3 filename, so only allow alphanumeric, - and _ in the actual file name.
    //The version label can still contain all that other stuff though.
    let s3filename = versionLabel.replace(/[^a-zA-Z0-9-_]/g, '-');

    let s3Key = `/${application}/${s3filename}.zip`;
    let deployStart, fileBuffer;

    readFile(file).then(result => {
        fileBuffer = result;

        if (bucket === null) {
            console.log(`No existing bucket name given, creating/requesting storage location`);
            return createStorageLocation();
        }
    }).then(result => {
        if (bucket === null) {
            expect(200, result, 'Failed to create storage location');
            bucket = result.data.CreateStorageLocationResponse.CreateStorageLocationResult.S3Bucket;
        }

        console.log(`Uploading file to bucket ${bucket}`);

        return checkIfFileExistsInS3(bucket, s3Key);
    }).then(result => {
        if (result.statusCode === 200) {
            throw new Error(`Version ${versionLabel} already exists in S3!`);
        }
        expect(404, result); 
        return uploadFileToS3(bucket, s3Key, fileBuffer);
    }).then(result => {
        expect(200, result);
        console.log(`New build successfully uploaded to S3, bucket=${bucket}, key=${s3Key}`);
        return createBeanstalkVersion(application, bucket, s3Key, versionLabel, versionDescription);
    }).then(result => {
        expect(200, result);
        console.log(`Created new application version ${versionLabel} in Beanstalk.`);
        if (!environmentName) {
            console.log(`No environment name given, so exiting now without deploying the new version ${versionLabel} anywhere.`);
            process.exit(0);
        }
        deployStart = new Date();
        console.log(`Starting deployment of version ${versionLabel} to environment ${environmentName}`);
        return deployBeanstalkVersion(application, environmentName, versionLabel, waitForRecoverySeconds);
    }).then(result => {
        expect(200, result);

        if (waitUntilDeploymentIsFinished) {
            console.log('Deployment started, "wait_for_deployment" was true...\n');
            return waitForDeployment(application, environmentName, versionLabel, deployStart, waitForRecoverySeconds);
        } else {
            console.log('Deployment started, parameter "wait_for_deployment" was false, so action is finished.');
            console.log('**** IMPORTANT: Please verify manually that the deployment succeeds!');
            process.exit(0);
        }

    }).then(envAfterDeployment => {
        if (envAfterDeployment.Health === 'Green') {
            console.log('Environment update successful!');
            process.exit(0);
        } else {
            console.warn(`Environment update finished, but environment health is: ${envAfterDeployment.Health}, HealthStatus: ${envAfterDeployment.HealthStatus}`);
            process.exit(1);
        }
    }).catch(err => {
        console.error(`Deployment failed: ${err}`);
        process.exit(2);
    }); 
}

function wasThrottled(result) {
    return result.statusCode === 400 && result.data && result.data.Error && result.data.Error.Code === 'Throttling';   
}

var deployVersionConsecutiveThrottlingErrors = 0;
//Deploys existing version in EB
function deployExistingVersion(application, environmentName, versionLabel, waitUntilDeploymentIsFinished, waitForRecoverySeconds) {
    let deployStart = new Date();
    console.log(`Deploying existing version ${versionLabel}`);


    deployBeanstalkVersion(application, environmentName, versionLabel).then(result => {

        if (result.statusCode !== 200) { 
            if (result.headers['content-type'] !== 'application/json') { //Not something we know how to handle ...
                throw new Error(`Status: ${result.statusCode}. Message: ${result.data}`);
            } else if (wasThrottled(result)) {
                deployVersionConsecutiveThrottlingErrors++;

                if (deployVersionConsecutiveThrottlingErrors >= 5) {
                    throw new Error(`Deployment failed, got ${deployVersionConsecutiveThrottlingErrors} throttling errors in a row while deploying existing version.`);
                } else {
                    return new Promise((resolve, reject) => {
                        reject({Code: 'Throttled'});
                    });
                }
            } else {
                throw new Error(`Status: ${result.statusCode}. Code: ${result.data.Error.Code}, Message: ${result.data.Error.Message}`);
            }
        }

        if (waitUntilDeploymentIsFinished) {
            console.log('Deployment started, "wait_for_deployment" was true...\n');
            return waitForDeployment(application, environmentName, versionLabel, deployStart, waitForRecoverySeconds);
        } else {
            console.log('Deployment started, parameter "wait_for_deployment" was false, so action is finished.');
            console.log('**** IMPORTANT: Please verify manually that the deployment succeeds!');
            process.exit(0);
        }
    }).then(envAfterDeployment => {
        if (envAfterDeployment.Health === 'Green') {
            console.log('Environment update successful!');
            process.exit(0);
        } else {
            console.warn(`Environment update finished, but environment health is: ${envAfterDeployment.Health}, HealthStatus: ${envAfterDeployment.HealthStatus}`);
            process.exit(1);
        }
    }).catch(err => {

        if (err.Code === 'Throttled') {
            console.log(`Call to deploy version was throttled. Waiting for 10 seconds before trying again ...`);
            setTimeout(() => deployExistingVersion(application, environmentName, versionLabel, waitUntilDeploymentIsFinished, waitForRecoverySeconds), 10 * 1000);
        } else {
            console.error(`Deployment failed: ${err}`);
            process.exit(2);
        }
    }); 
}


function strip(val) {
    //Strip leadig or trailing whitespace
    return (val || '').replace(/^\s*|\s*$/g, '');
}

function main() {

    let application, 
        environmentName, 
        versionLabel,
        versionDescription,
        region, 
        file,
        existingBucketName = null,
        useExistingVersionIfAvailable, 
        waitForRecoverySeconds = 30, 
        waitUntilDeploymentIsFinished = true; //Whether or not to wait for the deployment to complete...

    if (IS_GITHUB_ACTION) { //Running in GitHub Actions
        application = strip(process.env.INPUT_APPLICATION_NAME);
        environmentName = strip(process.env.INPUT_ENVIRONMENT_NAME);
        versionLabel = strip(process.env.INPUT_VERSION_LABEL);
        versionDescription = strip(process.env.INPUT_VERSION_DESCRIPTION);
        file = strip(process.env.INPUT_DEPLOYMENT_PACKAGE);

        awsApiRequest.accessKey = strip(process.env.INPUT_AWS_ACCESS_KEY);
        awsApiRequest.secretKey = strip(process.env.INPUT_AWS_SECRET_KEY);
        awsApiRequest.sessionToken = strip(process.env.INPUT_AWS_SESSION_TOKEN);
        awsApiRequest.region = strip(process.env.INPUT_REGION);

        if (process.env.INPUT_EXISTING_BUCKET_NAME) {
            existingBucketName = strip(process.env.INPUT_EXISTING_BUCKET_NAME);
        }

        if ((process.env.INPUT_WAIT_FOR_DEPLOYMENT || '').toLowerCase() == 'false') {
            waitUntilDeploymentIsFinished = false;
        }

        if (process.env.INPUT_WAIT_FOR_ENVIRONMENT_RECOVERY) {
            waitForRecoverySeconds = parseInt(process.env.INPUT_WAIT_FOR_ENVIRONMENT_RECOVERY);
        }
        useExistingVersionIfAvailable = process.env.INPUT_USE_EXISTING_VERSION_IF_AVAILABLE == 'true' || process.env.INPUT_USE_EXISTING_VERSION_IF_AVAILABLE == 'True';

    } else { //Running as command line script
        if (process.argv.length < 6) {
            console.log('\nbeanstalk-deploy: Deploy a zip file to AWS Elastic Beanstalk');
            console.log('https://github.com/einaregilsson/beanstalk-deploy\n');
            console.log('Usage: beanstalk-deploy.js <application> <environment> <versionLabel> <region> [<filename>]\n');
            console.log('Environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be defined for the program to work.');
            console.log('If <filename> is skipped the script will attempt to deploy an existing version named <versionLabel>.\n');
            process.exit(1);
        }

        [application, environmentName, versionLabel, region, file] = process.argv.slice(2);
        versionDescription = ''; //Not available for this.
        useExistingVersionIfAvailable = false; //This option is not available in the console version

        awsApiRequest.accessKey = strip(process.env.AWS_ACCESS_KEY_ID);
        awsApiRequest.secretKey = strip(process.env.AWS_SECRET_ACCESS_KEY);
        awsApiRequest.sessionToken = strip(process.env.AWS_SESSION_TOKEN);
        awsApiRequest.region = strip(region);
    }

    console.log('Beanstalk-Deploy: GitHub Action for deploying to Elastic Beanstalk.');
    console.log('https://github.com/einaregilsson/beanstalk-deploy');
    console.log('');

    if (!awsApiRequest.region) {
        console.error('Deployment failed: Region not specified!');
        process.exit(2);
    }
    if (!awsApiRequest.accessKey) {
        console.error('Deployment failed: AWS Access Key not specified!');
        process.exit(2);
    }
    if (!awsApiRequest.secretKey) {
        console.error('Deployment failed: AWS Secret Key not specified!');
        process.exit(2);
    }

    if (versionDescription.length > 200) {
        versionDescription = versionDescription.substr(0, 185) + ' [...TRUNCATED]';
    }

    console.log(' ***** Input parameters were: ***** ');
    console.log('         Application: ' + application);
    console.log('         Environment: ' + environmentName);
    console.log('       Version Label: ' + versionLabel);
    console.log(' Version description: ' + versionDescription);
    console.log('          AWS Region: ' + awsApiRequest.region);
    console.log('                File: ' + file);
    console.log('Existing bucket Name: ' + existingBucketName);
    console.log('      AWS Access Key: ' + awsApiRequest.accessKey.length + ' characters long, starts with ' + awsApiRequest.accessKey.charAt(0));
    console.log('      AWS Secret Key: ' + awsApiRequest.secretKey.length + ' characters long, starts with ' + awsApiRequest.secretKey.charAt(0));
    console.log(' Wait for deployment: ' + waitUntilDeploymentIsFinished);
    console.log('  Recovery wait time: ' + waitForRecoverySeconds);
    console.log('');

    getApplicationVersion(application, versionLabel).then(result => {

        expect(200, result);

        let versionsList = result.data.DescribeApplicationVersionsResponse.DescribeApplicationVersionsResult.ApplicationVersions;
        let versionAlreadyExists = versionsList.length === 1;

        if (versionAlreadyExists) {

            if (!environmentName) {
                if (useExistingVersionIfAvailable) {
                    console.log(`No environment set, but the version ${versionLabel} was found and "use_existing_version_if_available" is set to "true" - exiting successfully with no change`);
                    process.exit(0);
                } else {
                    console.error(`You have no environment set, so we are trying to only create version ${versionLabel}, but it already exists in Beanstalk and the parameter "use_existing_version_if_available" is not set to "true". If you want this to result in a no-op when the version already exists you must set "use_existing_version_if_available" to "true"`);
                    process.exit(2);
                }
            } else if (file && !useExistingVersionIfAvailable) {
                console.error(`Deployment failed: Version ${versionLabel} already exists. Either remove the "deployment_package" parameter to deploy existing version, or set the "use_existing_version_if_available" parameter to "true" to use existing version if it exists and deployment package if it doesn't.`);
                process.exit(2);
            } else {
                if (file && useExistingVersionIfAvailable) {
                    console.log(`Ignoring deployment package ${file} since version ${versionLabel} already exists and "use_existing_version_if_available" is set to true.`);
                }
                console.log(`Deploying existing version ${versionLabel}, version info:`);
                console.log(JSON.stringify(versionsList[0], null, 2));
                deployExistingVersion(application, environmentName, versionLabel, waitUntilDeploymentIsFinished, waitForRecoverySeconds);
            } 
        } else {
            if (file) {
                deployNewVersion(application, environmentName, versionLabel, versionDescription, file, existingBucketName, waitUntilDeploymentIsFinished, waitForRecoverySeconds);
            } else {
                console.error(`Deployment failed: No deployment package given but version ${versionLabel} doesn't exist, so nothing to deploy!`);
                process.exit(2);
            } 
        } 
    }).catch(err => {
        console.error(`Deployment failed: ${err}`);
        process.exit(2);
    });
}

function formatTimespan(since) {
    let elapsed = new Date().getTime() - since;
    let seconds = Math.floor(elapsed / 1000);
    let minutes = Math.floor(seconds / 60);
    seconds -= (minutes * 60);
    return `${minutes}m${seconds}s`;
}

//Wait until the new version is deployed, printing any events happening during the wait...
function waitForDeployment(application, environmentName, versionLabel, start, waitForRecoverySeconds) {
    let counter = 0;
    let degraded = false;
    let healThreshold;
    let deploymentFailed = false;

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;

    let waitPeriod = 10 * SECOND; //Start at ten seconds, increase slowly, long deployments have been erroring with too many requests.
    let waitStart = new Date().getTime();

    let eventCalls = 0, environmentCalls = 0; // Getting throttled on these print out how many we're doing...

    let consecutiveThrottleErrors = 0;

    return new Promise((resolve, reject) => {
        function update() {

            let elapsed = new Date().getTime() - waitStart;
            
            //Limit update requests for really long deploys
            if (elapsed > (10 * MINUTE)) {
                waitPeriod = 30 * SECOND;
            } else if (elapsed > 5 * MINUTE) {
                waitPeriod = 20 * SECOND;
            }

            describeEvents(application, environmentName, start).then(result => {
                eventCalls++;

                
                //Allow a few throttling failures...
                if (wasThrottled(result)) {
                    consecutiveThrottleErrors++;
                    console.log(`Request to DescribeEvents was throttled, that's ${consecutiveThrottleErrors} throttle errors in a row...`);
                    return;
                }

                consecutiveThrottleErrors = 0; //Reset the throttling count

                expect(200, result, `Failed in call to describeEvents, have done ${eventCalls} calls to describeEvents, ${environmentCalls} calls to describeEnvironments in ${formatTimespan(waitStart)}`);
                let events = result.data.DescribeEventsResponse.DescribeEventsResult.Events.reverse(); //They show up in desc, we want asc for logging...
                for (let ev of events) {
                    let date = new Date(ev.EventDate * 1000); //Seconds to milliseconds,
                    console.log(`${date.toISOString().substr(11,8)} ${ev.Severity}: ${ev.Message}`);
                    if (ev.Message.match(/Failed to deploy application/)) {
                        deploymentFailed = true; //wait until next iteration to finish, to get the final messages...
                    }
                }
                if (events.length > 0) {
                    start = new Date(events[events.length-1].EventDate * 1000 + 1000); //Add extra second so we don't get the same message next time...
                }
            }).catch(reject);
    
            describeEnvironments(application, environmentName).then(result => {
                environmentCalls++;

                //Allow a few throttling failures...
                if (wasThrottled(result)) {
                    consecutiveThrottleErrors++;
                    console.log(`Request to DescribeEnvironments was throttled, that's ${consecutiveThrottleErrors} throttle errors in a row...`);
                    if (consecutiveThrottleErrors >= 5) {
                        throw new Error(`Deployment failed, got ${consecutiveThrottleErrors} throttling errors in a row while waiting for deployment`);
                    }

                    setTimeout(update, waitPeriod);
                    return;
                }

                expect(200, result, `Failed in call to describeEnvironments, have done ${eventCalls} calls to describeEvents, ${environmentCalls} calls to describeEnvironments in ${formatTimespan(waitStart)}`);

                consecutiveThrottleErrors = 0;
                counter++;
                let env = result.data.DescribeEnvironmentsResponse.DescribeEnvironmentsResult.Environments[0];
                if (env.VersionLabel === versionLabel && env.Status === 'Ready') {
                    if (!degraded) {
                        console.log(`Deployment finished. Version updated to ${env.VersionLabel}`);
                        console.log(`Status for ${application}-${environmentName} is ${env.Status}, Health: ${env.Health}, HealthStatus: ${env.HealthStatus}`);
                       
                        if (env.Health === 'Green') {
                            resolve(env);   
                        } else {
                            console.warn(`Environment update finished, but health is ${env.Health} and health status is ${env.HealthStatus}. Giving it ${waitForRecoverySeconds} seconds to recover...`);
                            degraded = true;
                            healThreshold = new Date(new Date().getTime() + waitForRecoverySeconds * SECOND);
                            setTimeout(update, waitPeriod);
                        }
                    } else {
                        if (env.Health === 'Green') {
                            console.log(`Environment has recovered, health is now ${env.Health}, health status is ${env.HealthStatus}`);
                            resolve(env);
                        } else {
                            if (new Date().getTime() > healThreshold.getTime()) {
                                reject(new Error(`Environment still has health ${env.Health} ${waitForRecoverySeconds} seconds after update finished!`));
                            } else {
                                let left = Math.floor((healThreshold.getTime() - new Date().getTime()) / 1000);
                                console.warn(`Environment still has health: ${env.Health} and health status ${env.HealthStatus}. Waiting ${left} more seconds before failing...`);
                                setTimeout(update, waitPeriod);
                            }
                        }
                    }
                } else if (deploymentFailed) {
                    let msg = `Deployment failed! Current State: Version: ${env.VersionLabel}, Health: ${env.Health}, Health Status: ${env.HealthStatus}`;
                    console.log(`${new Date().toISOString().substr(11,8)} ERROR: ${msg}`);
                    reject(new Error(msg));
                } else {
                    if (counter % 6 === 0 && !deploymentFailed) {
                        console.log(`${new Date().toISOString().substr(11,8)} INFO: Still updating, status is "${env.Status}", health is "${env.Health}", health status is "${env.HealthStatus}"`);
                    }
                    setTimeout(update, waitPeriod);
                }
            }).catch(reject);
        }
    
        update();
    });
}

main();


