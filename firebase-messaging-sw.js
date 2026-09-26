importScripts(
    "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js"
);

importScripts(
    "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js"
);


firebase.initializeApp({

    apiKey:
        "AIzaSyDJFat47USz6KKaGuvj1dVjfELhRmH_2Tw",

    authDomain:
        "yuuchat-be666.firebaseapp.com",

    projectId:
        "yuuchat-be666",

    storageBucket:
        "yuuchat-be666.firebasestorage.app",

    messagingSenderId:
        "89509274877",

    appId:
        "1:89509274877:web:978a6179645ce88c3d4a94"

});


const messaging =
    firebase.messaging();


// ==================================================
// URLの決め方
// ・公開URL（GitHub Pages のサブパスなど）は決め打ちせず、
//   このService Workerのスコープ（= アプリの場所）を基準にする
// ・data.link は "./?open=chat&..." のような相対URL
// ・別のサイトへのリンクは開かない
// ==================================================

const APP_ICON =
    "./icons/icon-192.png";


function getAppScopeUrl() {

    return self.registration.scope;

}


function resolveAppUrl(link) {

    const scope =
        getAppScopeUrl();

    try {

        const url =
            new URL(
                link || "./",
                scope
            );

        if (url.origin !== self.location.origin) {
            return scope;
        }

        return url.href;

    } catch (error) {

        return scope;

    }

}


// ==================================================
// バックグラウンド通知
// ・Cloud Functions は data だけのメッセージを送る
//   （notification を付けないので、FCMの自動表示との二重表示が起きない）
// ・ここで1回だけ showNotification する
// ・tag が同じ通知は1件にまとまる
// ==================================================

messaging.onBackgroundMessage(
    payload => {

        console.log(
            "バックグラウンド通知を受信:",
            payload
        );


        // notification payload（Firebaseコンソールのテスト送信など）は
        // Firebase側が自動表示するので、ここでは表示しない（二重表示防止）
        if (payload.notification) {
            return;
        }


        const data =
            payload.data || {};


        const title =
            data.title ||
            "ゆうChat";


        const body =
            data.body ||
            "新しい通知があります。";


        const options = {

            body: body,

            icon:
                resolveAppUrl(APP_ICON),

            badge:
                resolveAppUrl(APP_ICON),

            data: {
                link:
                    data.link || "./"
            }

        };


        if (data.tag) {
            options.tag = data.tag;
        }


        return self.registration.showNotification(
            title,
            options
        );

    }
);


// ==================================================
// 通知を押したとき
// ・アプリのタブ／PWAがすでに開いていれば、それを前面に出して
//   開く画面をメッセージで知らせる
// ・開いていなければ、新しく開く
// ==================================================

self.addEventListener(
    "notificationclick",
    event => {

        event.notification.close();


        const targetUrl =
            resolveAppUrl(
                event.notification.data?.link
            );

        const scope =
            getAppScopeUrl();


        event.waitUntil(

            clients.matchAll(
                {
                    type:
                        "window",

                    includeUncontrolled:
                        true
                }
            ).then(
                async clientList => {

                    const appClient =
                        clientList.find(
                            client =>
                                client.url.startsWith(scope)
                        );


                    if (appClient) {

                        if ("focus" in appClient) {

                            try {
                                await appClient.focus();
                            } catch (error) {
                                console.warn(
                                    "タブを前面にできませんでした:",
                                    error
                                );
                            }

                        }


                        appClient.postMessage(
                            {
                                type:
                                    "yuuchat-open-link",

                                link:
                                    targetUrl
                            }
                        );

                        return;

                    }


                    if (clients.openWindow) {

                        return clients.openWindow(
                            targetUrl
                        );

                    }

                }
            )

        );

    }
);
