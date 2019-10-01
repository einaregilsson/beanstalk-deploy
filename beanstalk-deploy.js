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

function expect(status, result) {
    if (status !== result.statusCode) { 
        if (result.headers['content-type'] !== 'application/json') {
            throw new Error(`Status: ${result.statusCode}. Message: ${result.data}`);
        } else {
            throw new Error(`Status: ${result.statusCode}. Code: ${result.data.Error.Code}, Message: ${result.data.Error.Message}`);
        }
    }
}

function main() {

    let application, environmentName, versionLabel, region, file;
    if (IS_GITHUB_ACTION) { //Running in GitHub Actions
        application = process.env.INPUT_APPLICATION_NAME;
        environmentName = process.env.INPUT_ENVIRONMENT_NAME;
        versionLabel = process.env.INPUT_VERSION_LABEL;
        file = process.env.INPUT_DEPLOYMENT_PACKAGE;

        awsApiRequest.accessKey = process.env.INPUT_AWS_ACCESS_KEY;
        awsApiRequest.secretKey = process.env.INPUT_AWS_SECRET_KEY;
        awsApiRequest.region = process.env.INPUT_REGION;

    } else { //Running as command line script
        if (process.argv.length < 6) {
            console.log('\nbeanstalk-deploy: Deploy a zip file to AWS Elastic Beanstalk');
            console.log('https://github.com/einaregilsson/beanstalk-deploy\n');
            console.log('Usage: beanstalk-deploy.js <application> <environment> <versionLabel> <region> [<filename>]\n');
            console.log('Environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be defined for the program to work.')
            console.log('If <filename> is skipped there will be no deployment, the script will simply log events from the environment.\n');
            process.exit(1);
        }

        [application, environmentName, versionLabel, region, file] = process.argv.slice(2);

        awsApiRequest.accessKey = process.env.AWS_ACCESS_KEY_ID;
        awsApiRequest.secretKey = process.env.AWS_SECRET_ACCESS_KEY;
        awsApiRequest.region = region;
    }

    let s3Key = `/${application}/${versionLabel}.zip`;
    let bucket, deployStart, fileBuffer;

    if (!file && !IS_GITHUB_ACTION) { //when something fails during the monitoring, make it possible to just observe what's going on. Start 5 minutes ago...
        let fiveMinutesAgo = new Date(new Date().getTime() - 5 * 60 * 1000);
        waitForDeployment(application, environmentName, versionLabel, fiveMinutesAgo);
        return;
    }

    readFile(file).then(result => {
        fileBuffer = result;
        return createStorageLocation(region);
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
            console.log('Environment update successful!')
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

//Wait until the new version is deployed, printing any events happening during the wait...
function waitForDeployment(application, environmentName, versionLabel, start) {
    let counter = 0;
    let degraded = false;
    let healThreshold;
    return new Promise((resolve, reject) => {
        function update() {
            describeEvents(application, environmentName, start).then(result => {
                expect(200, result);
                let events = result.data.DescribeEventsResponse.DescribeEventsResult.Events.reverse(); //They show up in desc, we want asc for logging...
                for (let ev of events) {
                    let date = new Date(ev.EventDate * 1000); //Seconds to milliseconds,
                    console.log(`${date.toISOString().substr(11,8)} ${ev.Severity}: ${ev.Message}`);
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
                } else {
                    if (counter % 6 === 0) {
                        console.log(`${new Date().toISOString().substr(11,8)} INFO: Still updating, status is "${env.Status}", health is "${env.Health}", health status is "${env.HealthStatus}"`);
                    }
                    setTimeout(update, 5000);
                }
            }).catch(reject);
        };
    
        update();
    });
}

main();


