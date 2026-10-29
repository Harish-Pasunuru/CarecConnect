/* =========================================
   CARECOnNECT - AUTHENTICATION
========================================= */

const USERS_KEY = "homeTreatsUsers";
const LOGIN_KEY = "homeTreatsLoggedInUser";
const APPOINTMENTS_KEY = "homeTreatsAppointments";


/* =========================================
   CHECK LOGIN
========================================= */

function isLoggedIn() {

    return localStorage.getItem(LOGIN_KEY) !== null;

}


/* =========================================
   PROTECT PAGE
========================================= */

function requireLogin() {

    if (!isLoggedIn()) {

        alert("🔐 Please login first to access CareConnect.");

        window.location.href = "login.html";

    }

}


/* =========================================
   GET CURRENT USER
========================================= */

function getCurrentUser() {

    const user =
        localStorage.getItem(LOGIN_KEY);

    return user
        ? JSON.parse(user)
        : null;

}


/* =========================================
   NAVIGATION LOGIN CHECK
========================================= */

function checkLogin(event) {

    if (!isLoggedIn()) {

        event.preventDefault();

        alert("🔐 Please login first.");

        window.location.href = "login.html";

        return false;

    }

    return true;

}


/* =========================================
   LOGOUT
========================================= */

function logout() {

    localStorage.removeItem(LOGIN_KEY);

    alert("You have been logged out successfully.");

    window.location.href = "login.html";

}


/* =========================================
   GET APPOINTMENTS
========================================= */

function getAppointments() {

    return JSON.parse(

        localStorage.getItem(APPOINTMENTS_KEY)

    ) || [];

}


/* =========================================
   SAVE APPOINTMENT
========================================= */

function saveAppointment(appointment) {

    const appointments =
        getAppointments();

    appointments.push(appointment);

    localStorage.setItem(

        APPOINTMENTS_KEY,

        JSON.stringify(appointments)

    );

}
/* =========================================
   PROTECTED LINK
========================================= */

function protectedLink(event) {

    if (!isLoggedIn()) {

        event.preventDefault();

        alert(
            "🔐 Please login or register first to continue."
        );

        window.location.href =
            "login.html";

        return false;
    }

    return true;
}