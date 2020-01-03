# Beanstalk Deploy

Beanstalk Deploy is a GitHub action (and command line script) to deploy apps to AWS Elastic Beanstalk. It takes the application
name, environment name, version name, region and filename as parameters, uploads the file to S3, creates a new version in
Elastic Beanstalk, and then deploys that version to the environment. It will wait until the deployment is finished, logging
any messages from the environment during the update and exiting with a non-zero exit code if the deployment fails. It does
not handle rolling back the environment.

## Using as a GitHub Action

The action expects you to have already generated a zip file with the version to be deployed. Example:

```
name: Deploy master
on:
  push:
    branches:
    - master
    
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    
    - name: Checkout source code
      uses: actions/checkout@v1

    - name: Generate deployment package
      run: zip deploy.zip *.js *.json *.html *.css
      
    - name: Deploy to EB
      uses: einaregilsson/beanstalk-deploy@v4
      with:
        aws_access_key: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws_secret_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        application_name: MyApplicationName
        environment_name: MyApplication-Environment
        version_label: 12345
        region: us-west-2
        deployment_package: deploy.zip
```

### Deploying an existing version

You can also use the action to deploy an existing version. To do this simply omit the ```deployment-package``` input parameter.
The action will then assume that the version you pass in throught ```version_label``` already exists in Beanstalk and
attempt to deploy that. In the example below the action would attempt do deploy existing version 12345.

```
    - name: Deploy to EB
      uses: einaregilsson/beanstalk-deploy@v4
      with:
        aws_access_key: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws_secret_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        application_name: MyApplicationName
        environment_name: MyApplication-Environment
        version_label: 12345
        region: us-west-2
```

### Failure modes
If you're uploading a new version the action will fail if that file already exists in S3, if the application version
exists in Beanstalk and of course if the deployment fails. The action will wait until Beanstalk reports that the
environment is running the version you passed in and status is **Ready**. If health is not **Green** when the version is deployed
the action will wait 30 seconds to see if it recovers, and fail the deployment if it hasn't changed into **Green** mode. The
reason for this is that Beanstalk sometimes messes up health checks during deploys and they usually recover right after
the deployment and in those cases we don't want to fail the build.

## Using beanstalk-deploy as a command line program

Beanstalk-deploy assumes that you have the environment variables ```AWS_ACCESS_KEY_ID``` and ```AWS_SECRET_ACCESS_KEY```
defined. Pass the rest of the parameters in on the command line, like so:

```
beanstalk-deploy.js MyApplicationName MyApplication-Environment 12345 us-west-2 deploy.zip
```

Just like in the GitHub action you can skip the final file parameter and the program will attempt to deploy an existing
version instead.

The program is available as an [NPM Package](https://www.npmjs.com/package/beanstalk-deploy) so you can install it with
```npm install -g beanstalk-deploy``` and then you'll have the ```beanstalk-deploy``` command (without .js) available
everywhere. 

## Caveats

1. The S3 upload is a simple PUT request, we don't handle chunked upload. It has worked fine for files that are a 
few megabytes in size, if your files are much larger than that it may cause problems.
2. The script does not roll back if a deploy fails.
3. There is no integration with Git, like there is in the official EB cli. This script only takes a readymade zip file and
deploys it.

Finally, if you also want a nice GitHub Action to generate sequential build numbers, check out 
https://github.com/einaregilsson/build-number
