# Beanstalk Deploy

Beanstalk Deploy is a GitHub action (and command line script) to deploy apps to AWS Elastic Beanstalk. It takes the application
name, environment name, version name, region and filename as parameters, uploads the file to S3, creates a new version in
Elastic Beanstalk, and then deploys that version to the environment. It will wait until the deployment is finished, logging
any messages from the environment during the update and exiting with a non-zero exit code if the deployment fails. It does
not handle rolling back the environment.

## Using as a GitHub Action

The action expects you to have already generated a zip file with the version to be deployed. Example:

```yaml
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
      uses: actions/checkout@v2

    - name: Generate deployment package
      run: zip -r deploy.zip . -x '*.git*'

    - name: Deploy to EB
      uses: einaregilsson/beanstalk-deploy@v21
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
The action will then assume that the version you pass in through ```version_label``` already exists in Beanstalk and
attempt to deploy that. In the example below the action would attempt to deploy existing version 12345.

```yaml
    - name: Deploy to EB
      uses: einaregilsson/beanstalk-deploy@v22
      with:
        aws_access_key: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws_secret_key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        application_name: MyApplicationName
        environment_name: MyApplication-Environment
        version_label: 12345
        region: us-west-2
```

### Optional parameters

`aws_session_token`: If you are running the action with temporary security credentials using the AWS Security Token Service API. For example, you may be assuming a role in AWS to execute the deploy through something like AWS's [`configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials) action.

`use_existing_version_if_available`: This can be set to `true` and then
the program will deploy a version already in Elastic Beanstalk if it exists, but if it doesn't exist it will create it
from the deployment package you specify. This can be useful when deploying to multiple environments, based on commit message.
See issue <https://github.com/einaregilsson/beanstalk-deploy/issues/8> for example. This parameter is new in version 5, and is optional,
if you omit it the program will simply behave exactly as it did before, by looking at the existence of `deployment_package` to decide
whether to create a version or not.

`wait_for_deployment`: Whether the action should wait for the deployment to be complete in Elastic Beanstalk. Default is `true`.
Deployments, especially immutable ones can take a long time to complete and eat up a lot of GitHub Actions minutes. So if you prefer
to just start the deployment in Elastic Beanstalk and not wait for it to be completely finished then you can set this parameter to `false`.

`wait_for_environment_recovery`: The environment sometimes takes a while to return to Green status after the deployment
is finished. By default we wait 30 seconds after deployment before determining whether the environment is OK or not. You can
increase this timeout by putting here the number of seconds to wait. Especially smaller environments with less resources
might take a while to return to normal. Thanks to GitHub user [mantaroh](https://github.com/mantaroh) for this one.

`version_description`: Description for the version you're creating. Can be useful for instance to set it to the commit that
triggered the build, `version_description: ${{github.SHA}}`.

`environment_name`: In version 10 this parameter becomes optional. If you don't pass an environment in the action will simply create
the version but not deploy it anywhere.

`existing_bucket_name` *(since v18)*: Use this to provide an existing bucket name to upload your deployment package to.
*It will prevent the action from (re)creating a bucket during deployment as well.*
Omit this parameter to have the action create the bucket. The latter requires the API key used to have the applicable permissions.

`max_backoff_retries` *(since v21)*: Use this if you have a heavy load environment and need more than 10 exponential back-off retries.
10 retries is about 1m at its maximum.

### AWS Permissions

It should be enough for your AWS user to have the policies **AWSElasticBeanstalkWebTier** and **AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy** attached
to be able to deploy your project.

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

```.bash
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
3. There is no integration with Git, like there is in the official EB cli. This script only takes an already made zip file and
deploys it.
