#!/usr/bin/env node
// Author: Einar Egilsson, https://github.com/einaregilsson/beanstalk-deploy

const awsApiRequest = require('./aws-api-request');
const fs = require('fs');

const IS_GITHUB_ACTION = !!process.env.GITHUB_ACTION;

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
        host: `${bucket}.s3.amazonaws.com`,
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
        host: `${bucket}.s3.amazonaws.com`,
        path : s3Key,
        method: 'PUT',
        headers: { 'Content-Type' : 'application/octet-stream'},
        payload: filebuffer
    });
}

function createBeanstalkVersion(application, bucket, s3Key, versionLabel) {
    return awsApiRequest({
        service: 'elasticbeanstalk',
        querystring: {
            Operation: 'CreateApplicationVersion', 
            Version: '2010-12-01',
            ApplicationName : application,
            VersionLabel : versionLabel,
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

function expect(status, result) {
    if (status !== result.statusCode) { 
        if (result.headers['content-type'] !== 'application/json') {
            throw new Error(`Status: ${result.statusCode}. Message: ${result.data}`);
        } else {
            throw new Error(`Status: ${result.statusCode}. Code: ${result.data.Error.Code}, Message: ${result.data.Error.Message}`);
        }
    }
}

//Uploads zip file, creates new version and deploys it
function deployNewVersion(application, environmentName, versionLabel, file) {

    let s3Key = `/${application}/${versionLabel}.zip`;
    let bucket, deployStart, fileBuffer;

    readFile(file).then(result => {
        fileBuffer = result;
        return createStorageLocation();
    }).then(result => {
        expect(200, result );
        bucket = result.data.CreateStorageLocationResponse.CreateStorageLocationResult.S3Bucket;
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
        return createBeanstalkVersion(application, bucket, s3Key, versionLabel);
    }).then(result => {
        expect(200, result);
        console.log(`Created new application version ${versionLabel} in Beanstalk.`);
        deployStart = new Date();
        console.log(`Starting deployment of version ${versionLabel} to environment ${environmentName}`);
        return deployBeanstalkVersion(application, environmentName, versionLabel);
    }).then(result => {
        expect(200, result);
        console.log('Deployment started...\n');

        return waitForDeployment(application, environmentName, versionLabel, deployStart);

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

//Deploys existing version in EB
function deployExistingVersion(application, environmentName, versionLabel) {
    let deployStart = new Date();
    console.log(`Deploying existing version ${versionLabel}`);

    deployBeanstalkVersion(application, environmentName, versionLabel).then(result => {
        expect(200, result);
        console.log('Deployment started...\n');
        return waitForDeployment(application, environmentName, versionLabel, deployStart);
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

function main() {

    let application, environmentName, versionLabel, region, file, useExistingVersionIfAvailable;
    if (IS_GITHUB_ACTION) { //Running in GitHub Actions
        application = process.env.INPUT_APPLICATION_NAME;
        environmentName = process.env.INPUT_ENVIRONMENT_NAME;
        versionLabel = process.env.INPUT_VERSION_LABEL;
        file = process.env.INPUT_DEPLOYMENT_PACKAGE;

        awsApiRequest.accessKey = process.env.INPUT_AWS_ACCESS_KEY;
        awsApiRequest.secretKey = process.env.INPUT_AWS_SECRET_KEY;
        awsApiRequest.region = process.env.INPUT_REGION;
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
        useExistingVersionIfAvailable = false; //This option is not available in the console version

        awsApiRequest.accessKey = process.env.AWS_ACCESS_KEY_ID;
        awsApiRequest.secretKey = process.env.AWS_SECRET_ACCESS_KEY;
        awsApiRequest.region = region;
    }

    console.log('Beanstalk-Deploy: GitHub Action for deploying to Elastic Beanstalk.');
    console.log('https://github.com/einaregilsson/beanstalk-deploy');
    console.log('');

    if (!awsApiRequest.region) {
        console.error('Deployment failed: Region not specified!');
        process.exit(2);
    }

    getApplicationVersion(application, versionLabel).then(result => {

        let versionsList = result.data.DescribeApplicationVersionsResponse.DescribeApplicationVersionsResult.ApplicationVersions;
        let versionAlreadyExists = versionsList.length === 1;
        
        if (versionAlreadyExists) {
            if (file && !useExistingVersionIfAvailable) {
                console.error(`Deployment failed: Version ${versionLabel} already exists. Either remove the "deployment_package" parameter to deploy existing version, or set the "use_existing_version_if_available" parameter to "true" to use existing version if it exists and deployment package if it doesn't.`);
                process.exit(2);
            } else {
                if (file && useExistingVersionIfAvailable) {
                    console.log(`Ignoring deployment package ${file} since version ${versionLabel} already exists and "use_existing_version_if_available" is set to true.`);
                }
                console.log(`Deploying existing version ${versionLabel}, version info:`);
                console.log(JSON.stringify(versionsList[0], null, 2));
                deployExistingVersion(application, environmentName, versionLabel);
            } 
        } else {
            if (file) {
                deployNewVersion(application, environmentName, versionLabel, file);
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

//Wait until the new version is deployed, printing any events happening during the wait...
function waitForDeployment(application, environmentName, versionLabel, start) {
    let counter = 0;
    let degraded = false;
    let healThreshold;
    let deploymentFailed = false;


    return new Promise((resolve, reject) => {
        function update() {
            describeEvents(application, environmentName, start).then(result => {
                expect(200, result);
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
                expect(200, result);
                counter++;
                let env = result.data.DescribeEnvironmentsResponse.DescribeEnvironmentsResult.Environments[0];
                if (env.VersionLabel === versionLabel && env.Status === 'Ready') {
                    if (!degraded) {
                        console.log(`Deployment finished. Version updated to ${env.VersionLabel}`);
                        console.log(`Status for ${application}-${environmentName} is ${env.Status}, Health: ${env.Health}, HealthStatus: ${env.HealthStatus}`);
                       
                        if (env.Health === 'Green') {
                            resolve(env);   
                        } else {
                            console.warn(`Environment update finished, but health is ${env.Health} and health status is ${env.HealthStatus}. Giving it 30 seconds to recover...`);
                            degraded = true;
                            healThreshold = new Date(new Date().getTime() + 30 * 1000);
                            setTimeout(update, 5000);
                        }
                    } else {
                        if (env.Health === 'Green') {
                            console.log(`Environment has recovered, health is now ${env.Health}, health status is ${env.HealthStatus}`);
                            resolve(env);
                        } else {
                            if (new Date().getTime() > healThreshold.getTime()) {
                                reject(new Error(`Environment still has health ${env.Health} 30 seconds after update finished!`));
                            } else {
                                let left = Math.floor((healThreshold.getTime() - new Date().getTime()) / 1000);
                                console.warn(`Environment still has health: ${env.Health} and health status ${env.HealthStatus}. Waiting ${left} more seconds before failing...`);
                                setTimeout(update, 5000);
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
                    setTimeout(update, 5000);
                }
            }).catch(reject);
        }
    
        update();
    });
}

main();


