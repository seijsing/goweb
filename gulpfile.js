var gulp = require('gulp');
var http = require('http');
var connect = require('gulp-connect');
var fs = require('fs');
var rimraf = require('gulp-rimraf');
var runSequence = require('run-sequence');

//Validators
var jshint = require('gulp-jshint');
var stylish = require('jshint-stylish');

//Builders
var less = require('gulp-less');
var htmlBuilder = require('gulp-file-include');
var sitemap = require('gulp-sitemap');

//Optimizers
var concat = require('gulp-concat');
var uglify = require('gulp-uglify');
var imagemin = require('gulp-imagemin');
var minifyCSS = require('gulp-minify-css');

//Things for custom cloudfront thing
var AWS = require('aws-sdk');
var glob = require("glob")
var revall = require('gulp-rev-all');
var awspublish = require('gulp-awspublish');

/*
---------------------------------
Main functions
---------------------------------
*/

gulp.task('less', function () {
  return gulp.src('./dev/assets/less/site.less')
    .pipe(less())
    .pipe(gulp.dest('./dev/assets/css'));
});

gulp.task('css',['less'], function () {
  return gulp.src('./dev/assets/css/*.css')
  	.pipe(gulp.dest('./public/assets/css'));
});

gulp.task('js',['validate-js'], function () {
  return gulp.src(['./dev/assets/js/*.js','!dev/assets/js/site.js'])
    .pipe(concat('site.js'))
    .pipe(gulp.dest('./public/assets/js'));
});

gulp.task('validate-js', function () {
  return gulp.src(['./dev/assets/js/custom.js'])
    .pipe(jshint())
  	.pipe(jshint.reporter(stylish))
  	.pipe(jshint.reporter('fail'))
});

gulp.task('html', function () {
	return gulp.src(['./dev/pages/**/*.html','./dev/*.html','!dev/partials/**'])
		.pipe(htmlBuilder({ //Takes partials from the partial folder and build complete HTML files
	      prefix: '@@',
	      basepath: './dev/partials'
	    }))
    	.pipe(gulp.dest('./public/'));
});

gulp.task('img',function(){
  return gulp.src(['./dev/assets/img/**/*'])
    .pipe(gulp.dest('./public/assets/img'));
});

gulp.task('plugins',function(){
  return gulp.src(['./dev/assets/plugins/**'])
    .pipe(gulp.dest('./public/assets/plugins'));
});

/*
---------------------------------
Dev pipeline
---------------------------------
*/

//Set up our webserver
gulp.task('serve', ['less', 'css', 'js', 'html', 'img', 'plugins'], function(){
   var spawn = require('child_process').spawn;
   var log = function(data){ console.log("[Divshot] " + data.toString().trim()); }

   var server = spawn('divshot', ['server', '--port', '3000']);

   server.on('error', function(error) { console.log(error.stack) });
   server.stdout.on('data', log);
   server.stderr.on('data', log);
});

gulp.task('reload', ['less', 'css', 'js', 'html', 'img', 'plugins'], function(){
	connect.reload();
});

// Watch
gulp.task('watch', function() {
  // Watch .less files
  gulp.watch('./dev/assets/less/*.less', ['less', 'reload']);
  gulp.watch('./dev/assets/css/*.css', ['css', 'reload']);
  gulp.watch('./dev/assets/js/*.js', ['js', 'reload']);
  gulp.watch(['./dev/**/*.html','./dev/partials/*.html'], ['html', 'reload']);
  gulp.watch('./dev/assets/img/**', ['img', 'reload']);
  gulp.watch('./dev/assets/plugins/**', ['plugins', 'reload']);
});

gulp.task('default', ['serve', 'watch']);

/*
---------------------------------
Publish pipeline
---------------------------------
*/

//Clean the public-folder
gulp.task('clean', function() {
  return gulp.src('./public', { read: false }).pipe(rimraf());
});

//Minify, uglify and and optimize!
gulp.task('minify', ['less', 'css', 'js', 'html', 'img', 'plugins'], function(){

  //js
  gulp.src(['./public/assets/js/*.js'])
    .pipe(uglify())
    .pipe(gulp.dest('./public/assets/js/'));

  //css
  gulp.src(['public/assets/css/*.css'])
    .pipe(minifyCSS({keepBreaks:true}))
    .pipe(gulp.dest('./public/assets/css'));

  //img (return to make sure the pipe is done before moving on)
  return gulp.src('./public/assets/img/**/*')
    .pipe(imagemin())
    .pipe(gulp.dest('./public/assets/img'));

});

gulp.task('sitemap', ['build'], function () {
    return gulp.src('public/**/*.html')
        .pipe(sitemap({
            siteUrl: 'http://www.lime-go.se'
        }))
        .pipe(gulp.dest('./public'));
});

//Take this bad boy to S3
gulp.task('upload-s3',['build', 'sitemap'], function(){
  aws = JSON.parse(fs.readFileSync('./aws.json'));
  var publisher = awspublish.create(aws);
  var headers = {'Cache-Control': 'max-age=172800, no-transform, public'};

  return gulp.src('public/**')
    .pipe(revall({ignore: [/^\/favicon.ico$/g, '.html', 'sitemap.xml']}))
    .pipe(awspublish.gzip())
    .pipe(publisher.publish(headers))
    .pipe(publisher.cache())
    .pipe(awspublish.reporter());
});

//Take this bad boy and stage it
gulp.task('upload-s3-staging',['build'], function(){

  aws = JSON.parse(fs.readFileSync('./aws-staging.json'));

  var publisher = awspublish.create(aws);
  var headers = {'Cache-Control': 'max-age=172800, no-transform, public'};

  gulp.src('public/**')
    .pipe(revall({ignore: [/^\/favicon.ico$/g, '.html','sitemap.xml']}))
    .pipe(awspublish.gzip())
    .pipe(publisher.publish(headers))
    .pipe(publisher.cache())
    .pipe(awspublish.reporter())
});

//tell Cloudfront to behave
gulp.task('invalidate-cloudfront',['upload-s3'], function(){
  aws = JSON.parse(fs.readFileSync('./aws.json'));
  var cloudfront = new AWS.CloudFront({
      accessKeyId: aws.key,
      secretAccessKey: aws.secret
  });

  glob("public/**/*.html", function (er, files) {

  //remove 'public' from path. This most likely be made smarter with Glob, but I failed to do so.
  files = files.map(function(file){
      if(file.split("/").length > 2){ //are we dealing with the root or not
        return file.split("public").pop().replace('index.html',''); //Not root
      }
      else {
        return file.split("public").pop(); //Root, lets not remove the filename
      }
  });

  //Let's not forget the sitemap file!
  files.push("/sitemap.xml")

  console.log("Will invalidate:");
  console.log(files);
  var id = new Date().getTime().toString(); // Should be uniqe enough for us
    var params = {
      DistributionId: aws.distributionId,
      InvalidationBatch: {
        CallerReference: id,
        Paths: {
          Quantity: files.length,
          Items: files
        }
      }
    };

    return cloudfront.createInvalidation(params, function(err, data) {
      if (err){
        console.log(err, err.stack); // an error occurred
        return false;
      }
      else{
        console.log(data);// successful response
        return true;
      }
    });
  })
});

//Run minify, compress and move other files to public dir
gulp.task('build',['validate-js'], function(callback){
	runSequence('clean','minify', callback);
});

gulp.task('publish',['build', 'sitemap', 'upload-s3', 'invalidate-cloudfront']);

gulp.task('stage',['build', 'upload-s3-staging']);
