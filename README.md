## General

Definition: A palindrome is a word, phrase, number, or other sequence of characters, which reads the same backward or forward. The project implementation assumes one character is not a palindrome.
The task of identifying all palindromes in a string, I have divided on subtasks: 
-	Splitting a string on substrings
-	Check if a string is palindrome
-	Get only unique palindromes
-	Sort palindromes by length

## Structure of the project

+ /build – contains built project sources
+ /custom_modules – stores custom modules
+ /src – contains source files
+ /src/modules – contains AMD modules for Systemjs
+ /src/styles – stores stylesheets for the project
+ /src/dev.html –file to launch project on the development stage
+ /src/index.html – file to launch project on the production stage. It’s used on the build stage.
+ /test – contains source files related to testing the project
+ /test/lib – contains library dependencies
+ /test/spec – contains spec files
+ /test/spec.js – used to include specs dependencies
+ /test/index.html – file to run testing in browser

## Preconditions

- Install nodejs.
- Install Grunt globally: *npm install –g grunt*.
- Install CLI for Grunt: *npm install -g grunt-cli*.
- Install Grunt locally: run *npm install grunt* in project root directory.
- Install all required modules: *npm install*.

Also for development, you should allow http requests in browser.

## Configuration of build system

As build system I used grunt. All build tasks are described in Gruntfile.js.
Available tasks:
- *grunt live* – used to watch all changes in browser without refreshing the project.
- *grunt code* – used to inspect code with JSHint.
- *grunt test* – used to run tests.
- *grunt build* – used to build.
- *grunt release* – used on release stage. It runs subtasks: test, code and build. The task will fail if any of these subtasks do not complete successfully.

## Deployment

To deploy the project you need:
 1.	Run task *grunt release* in CLI for project root folder.
 2.	Copy all contents of build folder to hosting folder.
 3. Run index.html.

## Tests

There are two possibilities to run tests: 
- Use grunt test command to run tests from CLI.
- Launch a file /test/index.html to run tests in browser.
For tests, I used BDD framework Jasmine. For more detailed tests description, please refer to spec file – test/spec/palindrome.js.

	
